'use strict';

// Offline tests (Node >= 18 on the dev machine): npm test

const test = require('node:test');
const assert = require('node:assert');
const s = require('../lib/solarman');
const sg04lp3 = require('../lib/sg04lp3');

test('Modbus CRC matches the standard check value', () => {
  // 01 03 00 00 00 0A -> CRC C5 CD
  assert.strictEqual(s.crc16modbus(Buffer.from('01030000000a', 'hex')), 0xcdc5);
});

test('request frame layout', () => {
  const f = s.buildV5Frame(3152279402, 7, s.buildModbusRead(1, 3, 586, 6));
  assert.strictEqual(f[0], 0xa5);
  assert.strictEqual(f.readUInt16LE(1), 15 + 8);
  assert.strictEqual(f.readUInt16LE(3), 0x4510);
  assert.strictEqual(f.readUInt32LE(7), 3152279402);
  assert.strictEqual(f[f.length - 1], 0x15);
  assert.strictEqual(f.length, 11 + 23 + 2);
});

function fakeResponse(seq, regs) {
  const body = Buffer.alloc(3 + regs.length * 2);
  body[0] = 1; body[1] = 3; body[2] = regs.length * 2;
  regs.forEach((r, i) => body.writeUInt16BE(r, 3 + i * 2));
  const modbus = Buffer.concat([body, Buffer.alloc(2)]);
  modbus.writeUInt16LE(s.crc16modbus(body), body.length);
  const frame = Buffer.alloc(11 + 14 + modbus.length + 2);
  frame[0] = 0xa5;
  frame.writeUInt16LE(14 + modbus.length, 1);
  frame.writeUInt16LE(0x1510, 3);
  frame[5] = seq;
  modbus.copy(frame, 25);
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum += frame[i];
  frame[frame.length - 2] = sum & 0xff;
  frame[frame.length - 1] = 0x15;
  return frame;
}

test('response parsing round-trip', () => {
  const frame = fakeResponse(9, [1259, 5250, 52]);
  const modbus = s.parseV5Response(frame, 9);
  assert.deepStrictEqual(s.parseModbusRegisters(modbus, 3, 3), [1259, 5250, 52]);
  assert.throws(() => s.parseV5Response(frame, 10), /sequence/);
});

// Registers from a real scan of the Békésszentandrás SG04LP3, 2026-11-01.
const REAL = {
  514: 95, 515: 73, 516: 23226, 518: 21771, 520: 27, 521: 19, 522: 9150, 524: 63301,
  526: 340, 527: 53803, 528: 1, 529: 371, 534: 53082, 535: 2, 540: 1250, 541: 1417,
  586: 1259, 587: 5250, 588: 52, 590: 65418, 591: 65309, 609: 5004, 625: 3, 653: 281,
  672: 327, 673: 83, 676: 4081, 677: 8, 678: 3250, 679: 2,
};

test('SG04LP3 decoding of a real scan', () => {
  const regs = {};
  for (let r = 514; r <= 679; r++) regs[r] = REAL[r] || 0;
  const d = sg04lp3.decode(regs);
  assert.strictEqual(d.battery_power, -118); // charging
  assert.strictEqual(d.battery_current, -2.27);
  assert.strictEqual(d.battery_soc, 52);
  assert.strictEqual(d.battery_voltage, 52.5);
  assert.strictEqual(d.battery_temperature, 25.9);
  assert.strictEqual(d.solar_power, 410);
  assert.strictEqual(d.load_power, 281);
  assert.strictEqual(d.grid_power, 3);
  assert.strictEqual(d.inverter_temperature, 41.7);
  assert.strictEqual(d.daily_production, 37.1);
  assert.strictEqual(d.total_production, 18415.4);
  assert.strictEqual(d.total_sold, 6330.1);
});
