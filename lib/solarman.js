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
  frame.writeUInt32LE(loggerSerial >>> 0, 7);
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

function parseModbusRegisters(data, fc, count) {
  if (data.length < 5) throw new Error('Modbus response too short (' + data.length + ' bytes)');
  if (data[1] === (fc | 0x80)) throw new Error('Modbus exception ' + data[2]);
  const crc = data.readUInt16LE(data.length - 2);
  if (crc !== crc16modbus(data.slice(0, data.length - 2))) throw new Error('Modbus CRC mismatch');
  if (data[1] !== fc) throw new Error('Modbus function code mismatch');
  const n = Math.floor(data[2] / 2);
  if (n !== count) throw new Error('Modbus returned ' + n + ' registers, expected ' + count);
  const regs = new Array(n);
  for (let i = 0; i < n; i++) regs[i] = data.readUInt16BE(3 + i * 2);
  return regs;
}

class SolarmanClient {

  constructor({ host, serial, port = 8899, slave = 1, timeout = 8000, log = () => {} }) {
    this.host = host;
    this.serial = Number(serial);
    this.port = port;
    this.slave = slave;
    this.timeout = timeout;
    this.log = log;
    this._socket = null;
    this._connecting = null;
    this._buffer = Buffer.alloc(0);
    this._pending = null;
    this._queue = Promise.resolve();
    this._seq = Math.floor(Math.random() * 256);
  }

  readHoldingRegisters(start, count) {
    return this._enqueue(() => this._read(3, start, count));
  }

  readInputRegisters(start, count) {
    return this._enqueue(() => this._read(4, start, count));
  }

  close() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._connecting = null;
    this._buffer = Buffer.alloc(0);
    this._fail(new Error('Connection closed'));
  }

  // Requests are strictly sequential: the logger handles one at a time.
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _connect() {
    if (this._socket) return Promise.resolve();
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port, family: 4 });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout to ' + this.host + ':' + this.port));
      }, this.timeout);
      socket.setNoDelay(true);
      socket.once('connect', () => {
        clearTimeout(timer);
        this._socket = socket;
        this._connecting = null;
        resolve();
      });
      socket.on('data', data => this._onData(data));
      socket.on('error', err => {
        clearTimeout(timer);
        if (this._connecting) {
          this._connecting = null;
          reject(err);
        }
        this._fail(err);
      });
      socket.on('close', () => {
        if (this._socket === socket) this._socket = null;
        this._buffer = Buffer.alloc(0);
        this._fail(new Error('Connection closed by logger'));
      });
    });
    return this._connecting;
  }

  async _read(fc, start, count) {
    await this._connect();
    this._seq = (this._seq + 1) & 0xff;
    const seq = this._seq;
    const frame = buildV5Frame(this.serial, seq, buildModbusRead(this.slave, fc, start, count));

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        // A late answer would desync the stream, so start over next time.
        if (this._socket) this._socket.destroy();
        reject(new Error('No response from logger within ' + this.timeout + ' ms'));
      }, this.timeout);
      this._pending = {
        resolve: f => { clearTimeout(timer); resolve(f); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
      this._socket.write(frame);
    });

    return parseModbusRegisters(parseV5Response(response, seq), fc, count);
  }

  _onData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);
    for (;;) {
      const startIdx = this._buffer.indexOf(V5_START);
      if (startIdx < 0) { this._buffer = Buffer.alloc(0); return; }
      if (startIdx > 0) this._buffer = this._buffer.slice(startIdx);
      if (this._buffer.length < HEADER_LEN) return;
      const total = HEADER_LEN + this._buffer.readUInt16LE(1) + 2;
      if (this._buffer.length < total) return;
      const frame = this._buffer.slice(0, total);
      this._buffer = this._buffer.slice(total);
      const ctrl = frame.readUInt16LE(3);
      if (ctrl !== CTRL_RESPONSE) {
        // Heartbeats and other unsolicited logger frames.
        this.log('Skipping V5 frame with control code 0x' + ctrl.toString(16));
        continue;
      }
      if (this._pending) {
        const p = this._pending;
        this._pending = null;
        p.resolve(frame);
      }
    }
  }

  _fail(err) {
    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      p.reject(err);
    }
  }

}

// Solarman logger discovery: broadcast "WIFIKIT-214028-READ" to UDP 48899,
// loggers answer "ip,mac,serial".
function discover({ timeout = 3000, address = '255.255.255.255' } = {}) {
  return new Promise(resolve => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    const finish = () => {
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve(Array.from(found.values()));
    };
    socket.on('error', finish);
    socket.on('message', msg => {
      const parts = msg.toString('ascii').trim().split(',');
      if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
        found.set(parts[2], { host: parts[0], mac: parts[1], serial: Number(parts[2]) });
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(Buffer.from('WIFIKIT-214028-READ'), 48899, address);
      setTimeout(finish, timeout);
    });
  });
}

// Many loggers (e.g. LSW3 firmware LSW3_32_5406_SS_*) ignore UDP discovery.
// Fallback: find hosts in a /24 with TCP 8899 open.
function scanPort({ prefix, port = 8899, timeout = 800, concurrency = 64 }) {
  const probe = host => new Promise(resolve => {
    const socket = net.connect({ host, port, family: 4 });
    const done = ok => { socket.destroy(); resolve(ok ? host : null); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
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

// The logger's web UI shows its serial as `var cover_mid = "..."` in status.html.
function fetchLoggerSerial(host, { user = 'admin', password = 'admin', timeout = 4000 } = {}) {
  return new Promise(resolve => {
    const req = http.get({
      host,
      path: '/status.html',
      auth: user + ':' + password,
      timeout,
    }, res => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', chunk => { if (body.length < 200000) body += chunk; });
      res.on('end', () => {
        const m = /cover_mid\s*=\s*"\s*(\d+)\s*"/.exec(body);
        resolve(res.statusCode === 200 && m ? Number(m[1]) : null);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = {
  SolarmanClient,
  discover,
  scanPort,
  fetchLoggerSerial,
  crc16modbus,
  buildModbusRead,
  buildV5Frame,
  parseV5Response,
  parseModbusRegisters,
};
