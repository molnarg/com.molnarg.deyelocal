'use strict';

// Connection-handling tests against a local fake logger (npm test).

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const s = require('../lib/solarman');

function v5Frame(ctrl, seq, payload) {
  const frame = Buffer.alloc(11 + payload.length + 2);
  frame[0] = 0xa5;
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(ctrl, 3);
  frame[5] = seq;
  payload.copy(frame, 11);
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum += frame[i];
  frame[frame.length - 2] = sum & 0xff;
  frame[frame.length - 1] = 0x15;
  return frame;
}

// Response to a read request: register i of the block = start + i.
function respond(request) {
  const seq = request[5];
  const start = request.readUInt16BE(26 + 2);
  const count = request.readUInt16BE(26 + 4);
  const body = Buffer.alloc(3 + count * 2);
  body[0] = request[26]; body[1] = request[27]; body[2] = count * 2;
  for (let i = 0; i < count; i++) body.writeUInt16BE((start + i) & 0xffff, 3 + i * 2);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(s.crc16modbus(body), 0);
  return v5Frame(0x1510, seq, Buffer.concat([Buffer.alloc(14), body, crc]));
}

// Fake logger. `behave(request, socket, n)` decides what to send for the n-th request.
function fakeLogger(behave) {
  const state = { connections: 0, requests: 0, sockets: [] };
  const server = net.createServer(socket => {
    state.connections++;
    state.sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', data => {
      for (let off = 0; off + 36 <= data.length; off += 36) {
        behave(data.slice(off, off + 36), socket, state.requests++);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.port = server.address().port;
    state.stop = () => {
      state.sockets.forEach(x => x.destroy());
      return new Promise(r => server.close(r));
    };
    resolve(state);
  }));
}

const SERIAL = 3152279402;

test('heartbeats, split frames and a false start byte are handled', async () => {
  const logger = await fakeLogger((req, socket) => {
    const heartbeat = v5Frame(0x4710, 0, Buffer.from([0x00]));
    const junk = Buffer.from([0xa5, 0xff, 0xff, 0x00]); // claims a 64 KB payload
    const resp = respond(req);
    socket.write(Buffer.concat([heartbeat, junk, resp.slice(0, 10)]));
    setTimeout(() => socket.write(resp.slice(10)), 20);
  });
  const client = new s.SolarmanClient({ host: '127.0.0.1', port: logger.port, serial: SERIAL, timeout: 1000 });
  assert.deepStrictEqual(await client.readHoldingRegisters(586, 3), [586, 587, 588]);
  assert.deepStrictEqual(await client.readHoldingRegisters(10, 1), [10]);
  assert.strictEqual(logger.connections, 1);
  client.close();
  await logger.stop();
});

test('a timeout drops the connection and the next read reconnects', async () => {
  const logger = await fakeLogger((req, socket, n) => {
    if (n > 0) socket.write(respond(req)); // ignore the first request
  });
  const client = new s.SolarmanClient({ host: '127.0.0.1', port: logger.port, serial: SERIAL, timeout: 200 });
  await assert.rejects(client.readHoldingRegisters(1, 1), /No response/);
  assert.deepStrictEqual(await client.readHoldingRegisters(2, 1), [2]);
  assert.strictEqual(logger.connections, 2);
  client.close();
  await logger.stop();
});

test('the logger closing the connection fails the read, then reconnects', async () => {
  const logger = await fakeLogger((req, socket, n) => {
    if (n === 0) socket.destroy();
    else socket.write(respond(req));
  });
  const client = new s.SolarmanClient({ host: '127.0.0.1', port: logger.port, serial: SERIAL, timeout: 1000 });
  await assert.rejects(client.readHoldingRegisters(1, 1), /closed/);
  assert.deepStrictEqual(await client.readHoldingRegisters(5, 2), [5, 6]);
  client.close();
  await logger.stop();
});

test('close() rejects the read in flight and queued reads, and never reconnects', async () => {
  const logger = await fakeLogger(() => {}); // never answers
  const client = new s.SolarmanClient({ host: '127.0.0.1', port: logger.port, serial: SERIAL, timeout: 5000 });
  const inFlight = client.readHoldingRegisters(1, 1);
  const queued = client.readHoldingRegisters(2, 1);
  await new Promise(r => setTimeout(r, 100));
  const t = Date.now();
  client.close();
  await assert.rejects(inFlight, /closed/);
  await assert.rejects(queued, /closed/);
  await assert.rejects(client.readHoldingRegisters(3, 1), /closed/);
  assert.ok(Date.now() - t < 1000);
  assert.strictEqual(logger.connections, 1);
  await logger.stop();
});

test('close() while still connecting does not leave a connection behind', async () => {
  const logger = await fakeLogger(() => {});
  const client = new s.SolarmanClient({ host: '127.0.0.1', port: logger.port, serial: SERIAL, timeout: 1000 });
  const read = client.readHoldingRegisters(1, 1);
  client.close(); // the connect is still in flight
  await assert.rejects(read, /closed/);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(client._socket, null);
  assert.strictEqual(logger.requests, 0);
  await logger.stop();
});

test('a failed connect does not poison later connects', async () => {
  const server = net.createServer();
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  await new Promise(r => server.close(r)); // nothing listens on `port` now
  const client = new s.SolarmanClient({ host: '127.0.0.1', port, serial: SERIAL, timeout: 500 });
  await assert.rejects(client.readHoldingRegisters(1, 1));
  assert.strictEqual(client._connecting, null);
  await assert.rejects(client.readHoldingRegisters(1, 1));
  client.close();
});

test('serial and host validation', () => {
  assert.ok(s.isValidSerial('3152279402'));
  assert.ok(!s.isValidSerial('4294967296'));
  assert.ok(!s.isValidSerial('12a'));
  assert.ok(!s.isValidSerial(''));
  assert.ok(s.isValidHost('192.168.31.136'));
  assert.ok(!s.isValidHost('192.168.31.256'));
  assert.ok(!s.isValidHost(''));
  assert.throws(() => new s.SolarmanClient({ host: '1.2.3.4', serial: '99999999999' }));
});

test('fetchLoggerSerial: parses the status page and gives up on a stalled server', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/status.html' && req.headers.host.startsWith('127.0.0.1')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (server.stall) { res.write('var cover_'); return; } // headers, then nothing
      res.end('var cover_mid = "3152279402";');
    }
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const host = '127.0.0.1';
  const get = opts => new Promise(resolve => {
    // fetchLoggerSerial always uses port 80: redirect it to the test server.
    const orig = http.get;
    http.get = (o, cb) => orig(Object.assign({}, o, { port }), cb);
    s.fetchLoggerSerial(host, opts).then(v => { http.get = orig; resolve(v); });
  });
  assert.strictEqual(await get({ timeout: 1000 }), 3152279402);
  server.stall = true;
  const t = Date.now();
  assert.strictEqual(await get({ timeout: 300 }), null);
  assert.ok(Date.now() - t < 1000);
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});
