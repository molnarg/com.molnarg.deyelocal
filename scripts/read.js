'use strict';

// Read the inverter once (or every N seconds) from a dev machine:
//   node scripts/read.js <logger-ip> <logger-serial> [interval-seconds]
//   node scripts/read.js discover

const { SolarmanClient, discover } = require('../lib/solarman');
const sg04lp3 = require('../lib/sg04lp3');

async function main() {
  const [host, serial, interval] = process.argv.slice(2);
  if (host === 'discover') {
    console.log(await discover());
    return;
  }
  if (!host || !serial) {
    console.error('usage: node scripts/read.js <logger-ip> <logger-serial> [interval-seconds] | discover');
    process.exit(2);
  }
  const client = new SolarmanClient({ host, serial, log: console.log });
  console.log(await sg04lp3.identify(client));
  for (;;) {
    const t = Date.now();
    const data = await sg04lp3.read(client);
    console.log(new Date().toISOString(), (Date.now() - t) + ' ms', JSON.stringify(data));
    if (!interval) break;
    await new Promise(r => setTimeout(r, Number(interval) * 1000));
  }
  client.close();
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
