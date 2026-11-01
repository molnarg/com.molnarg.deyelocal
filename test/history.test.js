'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { History } = require('../lib/history');

const POLL = 10000;
const opts = (now, extra) => Object.assign({
  now, key: 'surplus', comparison: 'above', threshold: 3000, seconds: 60, pollInterval: POLL, maxGap: 3 * POLL,
}, extra);

function filled(values, start = 0) {
  const h = new History();
  values.forEach((v, i) => h.add(start + i * POLL, { surplus: v }));
  return h;
}

test('above for the whole window', () => {
  const h = filled([3500, 3600, 3100, 3200, 4000, 3900, 3800]); // t = 0..60 s
  assert.strictEqual(h.holds(opts(60000)), true);
});

test('one dip inside the window makes it false', () => {
  const h = filled([3500, 3600, 2900, 3200, 4000, 3900, 3800]);
  assert.strictEqual(h.holds(opts(60000)), false);
});

test('a dip before the window does not count', () => {
  const h = filled([100, 3500, 3600, 3100, 3200, 4000, 3900, 3800]); // dip at t = 0
  assert.strictEqual(h.holds(opts(70000)), true);
});

test('not enough history yet (e.g. right after a restart) is false', () => {
  const h = filled([5000, 5000, 5000], 100000); // only 20 s of data
  assert.strictEqual(h.holds(opts(120000)), false);
  // The same data satisfies a 20 s window.
  assert.strictEqual(h.holds(opts(120000, { seconds: 20 })), true);
});

test('clear() restarts the window', () => {
  const h = filled([5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  assert.strictEqual(h.holds(opts(60000)), true);
  h.clear();
  h.add(60000, { surplus: 5000 });
  assert.strictEqual(h.holds(opts(60000)), false);
});

test('stale data is false', () => {
  const h = filled([5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  assert.strictEqual(h.holds(opts(60000 + 31000)), false);
});

test('a gap (device unavailable) inside the window is false', () => {
  const h = new History();
  [0, 10, 20, 60, 70, 80].forEach(s => h.add(s * 1000, { surplus: 5000 }));
  assert.strictEqual(h.holds(opts(80000)), false);
});

test('below, with a 10 s window: one or two samples decide', () => {
  const h = filled([500, 200, -1600, -1800]); // t = 0..30 s
  const o = opts(30000, { comparison: 'below', threshold: -1500, seconds: 10 });
  assert.strictEqual(h.holds(o), true);
  h.add(40000, { surplus: -1000 });
  assert.strictEqual(h.holds(Object.assign(o, { now: 40000 })), false);
});

test('other keys', () => {
  const h = new History();
  for (let s = 0; s <= 120; s += 10) h.add(s * 1000, { solar: 7000, battery: 97 });
  assert.strictEqual(h.holds(opts(120000, { key: 'solar', threshold: 6500, seconds: 120 })), true);
  assert.strictEqual(h.holds(opts(120000, { key: 'battery', threshold: 95, seconds: 120 })), true);
  assert.strictEqual(h.holds(opts(120000, { key: 'surplus' })), false); // no such values
});
