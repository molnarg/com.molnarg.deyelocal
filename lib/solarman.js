'use strict';

// Minimal Solarman V5 client: Modbus RTU over TCP port 8899 of a Solarman
// Wi-Fi logger stick (LSW-3 and similar). Read-only (function codes 3 and 4).
//
// Protocol reference: jmccrohan/pysolarmanv5 (MIT) and the transport in
// gpmachado/gpm.deye.solarpanel.tcp (MIT).
//
// Written for Node 12 (Homey Pro Early 2019): no optional chaining or ??.

const net = require('net');
const dgram = require('dgram');
const http = require('http');

const V5_START = 0xa5;
const V5_END = 0x15;
const CTRL_REQUEST = 0x4510;
const CTRL_RESPONSE = 0x1510;
const HEADER_LEN = 11;
// Real frames are < 300 bytes. Anything claiming more is a false start byte.
const MAX_PAYLOAD = 1024;

function isValidHost(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host).trim());
  return !!m && m.slice(1).every(n => Number(n) <= 255);
}

function isValidSerial(serial) {
  const s = String(serial).trim();
  return /^\d{1,10}$/.test(s) && Number(s) > 0 && Number(s) <= 0xffffffff;
}

function crc16modbus(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return crc;
}

// Sum of all bytes except the start byte and the 2-byte trailer.
function v5checksum(frame) {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum += frame[i];
  return sum & 0xff;
}

function buildModbusRead(slave, fc, start, count) {
  const msg = Buffer.alloc(8);
  msg.writeUInt8(slave, 0);
  msg.writeUInt8(fc, 1);
  msg.writeUInt16BE(start, 2);
  msg.writeUInt16BE(count, 4);
  msg.writeUInt16LE(crc16modbus(msg.slice(0, 6)), 6);
  return msg;
}

function buildV5Frame(loggerSerial, seq, modbus) {
  // Payload: frame type 0x02, sensor type (2), delivery time (4),
  // power-on time (4), offset time (4), then the Modbus RTU frame.
  const payloadLen = 15 + modbus.length;
  const frame = Buffer.alloc(HEADER_LEN + payloadLen + 2);
  frame.writeUInt8(V5_START, 0);
  frame.writeUInt16LE(payloadLen, 1);
  frame.writeUInt16LE(CTRL_REQUEST, 3);
  frame.writeUInt16LE(seq, 5);
  frame.writeUInt32LE(loggerSerial, 7);
  frame.writeUInt8(0x02, 11);
  modbus.copy(frame, HEADER_LEN + 15);
  frame[frame.length - 2] = v5checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

// Returns the embedded Modbus RTU response of a V5 response frame.
function parseV5Response(frame, seq) {
  if (frame.length < 29) throw new Error('V5 response too short (' + frame.length + ' bytes)');
  if (frame[0] !== V5_START || frame[frame.length - 1] !== V5_END) throw new Error('V5 framing error');
  if (frame[frame.length - 2] !== v5checksum(frame)) throw new Error('V5 checksum mismatch');
  if (frame[5] !== (seq & 0xff)) throw new Error('V5 sequence mismatch');
  // 11 header + 14 payload header (frame type, status, 3 x 4-byte times).
  return frame.slice(25, frame.length - 2);
}

function parseModbusRegisters(data, fc, count, slave) {
  if (data.length < 5) throw new Error('Modbus response too short (' + data.length + ' bytes)');
  const crc = data.readUInt16LE(data.length - 2);
  if (crc !== crc16modbus(data.slice(0, data.length - 2))) throw new Error('Modbus CRC mismatch');
  if (slave !== undefined && data[0] !== slave) throw new Error('Modbus slave address mismatch');
  if (data[1] === (fc | 0x80)) throw new Error('Modbus exception ' + data[2]);
  if (data[1] !== fc) throw new Error('Modbus function code mismatch');
  const n = Math.floor(data[2] / 2);
  if (n !== count) throw new Error('Modbus returned ' + n + ' registers, expected ' + count);
  if (data.length < 3 + n * 2 + 2) throw new Error('Modbus response truncated');
  const regs = new Array(n);
  for (let i = 0; i < n; i++) regs[i] = data.readUInt16BE(3 + i * 2);
  return regs;
}

// One TCP connection to one logger, used for strictly sequential requests
// (the logger handles one at a time). Any error drops the connection; the next
// request reconnects. reset() drops the connection on purpose; close() is
// final: everything queued or in flight is rejected and nothing reconnects.
class SolarmanClient {

  constructor({ host, serial, port = 8899, slave = 1, timeout = 8000, log = () => {} }) {
    if (!isValidSerial(serial)) throw new Error('Invalid logger serial: ' + serial);
    this.host = String(host).trim();
    this.serial = Number(serial);
    this.port = port;
    this.slave = slave;
    this.timeout = timeout;
    this.log = log;
    this._closed = false;
    this._socket = null; // connected socket
    this._connecting = null; // { socket, promise, fail(err) } while connecting
    this._buffer = Buffer.alloc(0);
    this._pending = null; // { resolve, reject } of the request in flight
    this._queue = Promise.resolve();
    this._seq = Math.floor(Math.random() * 256);
  }

  readHoldingRegisters(start, count) {
    return this._enqueue(() => this._read(3, start, count));
  }

  readInputRegisters(start, count) {
    return this._enqueue(() => this._read(4, start, count));
  }

  reset() {
    this._drop(new Error('Connection reset'));
  }

  close() {
    this._closed = true;
    this._drop(new Error('Client closed'));
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _checkOpen() {
    if (this._closed) throw new Error('Client closed');
  }

  // Destroy the current and the connecting socket and fail whatever waits on them.
  _drop(err) {
    const connecting = this._connecting;
    this._connecting = null;
    if (connecting) {
      connecting.socket.destroy();
      connecting.fail(err);
    }
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._buffer = Buffer.alloc(0);
    this._failPending(err);
  }

  _connect() {
    if (this._socket) return Promise.resolve(this._socket);
    if (this._connecting) return this._connecting.promise;

    const socket = net.connect({ host: this.host, port: this.port, family: 4 });
    const attempt = { socket };
    attempt.promise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error('Connection timeout to ' + this.host + ':' + this.port));
      }, this.timeout);
      const fail = err => {
        clearTimeout(timer);
        if (this._connecting === attempt) this._connecting = null;
        socket.destroy();
        if (!settled) { settled = true; reject(err); }
      };
      attempt.fail = fail;

      socket.setNoDelay(true);
      socket.once('connect', () => {
        clearTimeout(timer);
        if (settled || this._connecting !== attempt) {
          socket.destroy(); // aborted by reset()/close() meanwhile
          return;
        }
        settled = true;
        this._connecting = null;
        this._socket = socket;
        this._buffer = Buffer.alloc(0);
        resolve(socket);
      });
      socket.on('data', data => {
        if (this._socket === socket) this._onData(data);
      });
      socket.on('error', err => {
        if (!settled) fail(err);
        else if (this._socket === socket) this._lost(socket, err);
      });
      socket.on('close', () => {
        if (!settled) fail(new Error('Connection closed while connecting'));
        else if (this._socket === socket) this._lost(socket, new Error('Connection closed by logger'));
      });
    });
    this._connecting = attempt;
    return attempt.promise;
  }

  _lost(socket, err) {
    socket.destroy();
    if (this._socket === socket) {
      this._socket = null;
      this._buffer = Buffer.alloc(0);
    }
    this._failPending(err);
  }

  async _read(fc, start, count) {
    this._checkOpen();
    const socket = await this._connect();
    this._checkOpen();
    if (this._socket !== socket) throw new Error('Connection lost');

    this._seq = (this._seq + 1) & 0xff;
    const seq = this._seq;
    const frame = buildV5Frame(this.serial, seq, buildModbusRead(this.slave, fc, start, count));

    const response = await new Promise((resolve, reject) => {
      const pending = {};
      const timer = setTimeout(() => {
        // A late answer would desync the stream, so drop the connection.
        this._lost(socket, new Error('No response from logger within ' + this.timeout + ' ms'));
      }, this.timeout);
      pending.resolve = f => { clearTimeout(timer); resolve(f); };
      pending.reject = e => { clearTimeout(timer); reject(e); };
      this._pending = pending;
      socket.write(frame);
    });

    return parseModbusRegisters(parseV5Response(response, seq), fc, count, this.slave);
  }

  _onData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);
    for (;;) {
      const startIdx = this._buffer.indexOf(V5_START);
      if (startIdx < 0) { this._buffer = Buffer.alloc(0); return; }
      if (startIdx > 0) this._buffer = this._buffer.slice(startIdx);
      if (this._buffer.length < HEADER_LEN) return;
      const payloadLen = this._buffer.readUInt16LE(1);
      if (payloadLen > MAX_PAYLOAD) { this._buffer = this._buffer.slice(1); continue; }
      const total = HEADER_LEN + payloadLen + 2;
      if (this._buffer.length < total) return;
      if (this._buffer[total - 1] !== V5_END) { this._buffer = this._buffer.slice(1); continue; }
      const frame = this._buffer.slice(0, total);
      this._buffer = this._buffer.slice(total);
      // Heartbeats and other unsolicited frames have other control codes.
      if (frame.readUInt16LE(3) === CTRL_RESPONSE && this._pending) {
        const p = this._pending;
        this._pending = null;
        p.resolve(frame);
      }
    }
  }

  _failPending(err) {
    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      p.reject(err);
    }
  }

}

// Solarman logger discovery: broadcast "WIFIKIT-214028-READ" to UDP 48899,
// loggers answer "ip,mac,serial". Many loggers (e.g. LSW3 firmware
// LSW3_32_5406_SS_*) don't answer at all.
function discover({ timeout = 3000, address = '255.255.255.255' } = {}) {
  return new Promise(resolve => {
    const found = new Map();
    let done = false;
    const socket = dgram.createSocket('udp4');
    const finish = () => {
      if (done) return;
      done = true;
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve(Array.from(found.values()));
    };
    socket.on('error', finish);
    socket.on('message', msg => {
      const parts = msg.toString('ascii').trim().split(',');
      if (parts.length >= 3 && isValidHost(parts[0]) && isValidSerial(parts[2])) {
        found.set(parts[2], { host: parts[0], mac: parts[1], serial: Number(parts[2]) });
      }
    });
    setTimeout(finish, timeout);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(Buffer.from('WIFIKIT-214028-READ'), 48899, address, err => { if (err) finish(); });
      } catch (e) {
        finish();
      }
    });
  });
}

// Find hosts in a /24 with a TCP port open.
function scanPort({ prefix, port = 8899, timeout = 800, concurrency = 32 }) {
  const probe = host => new Promise(resolve => {
    const socket = net.connect({ host, port, family: 4 });
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok ? host : null);
    };
    const timer = setTimeout(() => done(false), timeout);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
  const hosts = [];
  for (let i = 1; i < 255; i++) hosts.push(prefix + '.' + i);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = await probe(hosts[next++]);
      if (host) found.push(host);
    }
  };
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  return Promise.all(workers).then(() => found);
}

// The logger's web UI shows its serial as `var cover_mid = "..."` in
// status.html (HTTP basic auth). Resolves null on any failure, always within
// `timeout`.
function fetchLoggerSerial(host, { user = 'admin', password = 'admin', timeout = 4000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let req = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    req = http.get({ host, path: '/status.html', auth: user + ':' + password }, res => {
      if (res.statusCode !== 200) { res.resume(); finish(null); return; }
      let body = '';
      res.setEncoding('latin1');
      res.on('data', chunk => { if (body.length < 200000) body += chunk; });
      res.on('end', () => {
        const m = /cover_mid\s*=\s*"\s*(\d+)\s*"/.exec(body);
        finish(m && isValidSerial(m[1]) ? Number(m[1]) : null);
      });
      res.on('aborted', () => finish(null));
      res.on('error', () => finish(null));
      res.on('close', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

// Loggers on the /24 of `localAddress` ("192.168.31.21" or "192.168.31.21:80"):
// UDP discovery first, then a TCP 8899 scan plus the serial from each
// candidate's web page. Entries are { host, serial } with serial null when the
// web page couldn't be read (e.g. changed login).
async function findLoggers(localAddress, log = () => {}) {
  const viaUdp = await discover({ timeout: 2000 });
  log('UDP discovery:', JSON.stringify(viaUdp));
  if (viaUdp.length) return viaUdp.map(l => ({ host: l.host, serial: l.serial }));

  const m = /^(\d+\.\d+\.\d+)\.\d+/.exec(localAddress || '');
  if (!m) return [];
  const hosts = await scanPort({ prefix: m[1] });
  log('Hosts with port 8899 open in ' + m[1] + '.0/24:', JSON.stringify(hosts));
  const out = [];
  for (const host of hosts) out.push({ host, serial: await fetchLoggerSerial(host) });
  return out;
}

module.exports = {
  SolarmanClient,
  discover,
  scanPort,
  fetchLoggerSerial,
  findLoggers,
  isValidHost,
  isValidSerial,
  crc16modbus,
  buildModbusRead,
  buildV5Frame,
  parseV5Response,
  parseModbusRegisters,
};
