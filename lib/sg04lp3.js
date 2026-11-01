'use strict';

// Register map for Deye three-phase low-voltage hybrid inverters (SG04LP3:
// SUN-5K..12K-SG04LP3-EU and similar; register 0 = 0x0005).
// Addresses and scaling from inverter_definitions/deye_sg04lp3.json in
// gpmachado/gpm.deye.solarpanel.tcp (MIT), which derives from
// StephanJoubert/home_assistant_solarman (Apache-2.0).
//
// Sign conventions are Deye's own, and the same as the com.heszi.deye cloud app:
//   battery power: negative = charging, positive = discharging
//   grid power:    positive = importing, negative = exporting

// Two reads per poll (a Modbus read can return at most 125 registers).
const BLOCKS = [
  { start: 514, count: 78 }, // 514..591: daily/total energy, temperatures, battery
  { start: 598, count: 82 }, // 598..679: grid, load, PV
];

// type: u16, s16, u32 (low word first). value = (raw - offset) * scale.
const FIELDS = {
  pv1_power: { reg: 672, type: 'u16' },
  pv2_power: { reg: 673, type: 'u16' },
  pv1_voltage: { reg: 676, type: 'u16', scale: 0.1 },
  pv2_voltage: { reg: 678, type: 'u16', scale: 0.1 },
  battery_power: { reg: 590, type: 's16' },
  battery_soc: { reg: 588, type: 'u16' },
  battery_voltage: { reg: 587, type: 'u16', scale: 0.01 },
  battery_current: { reg: 591, type: 's16', scale: 0.01 },
  battery_temperature: { reg: 586, type: 'u16', offset: 1000, scale: 0.1 },
  grid_power: { reg: 625, type: 's16' },
  grid_frequency: { reg: 609, type: 'u16', scale: 0.01 },
  load_power: { reg: 653, type: 'u16' },
  inverter_temperature: { reg: 541, type: 's16', offset: 1000, scale: 0.1 },
  dc_temperature: { reg: 540, type: 's16', offset: 1000, scale: 0.1 },
  daily_production: { reg: 529, type: 'u16', scale: 0.1 },
  daily_consumption: { reg: 526, type: 'u16', scale: 0.1 },
  daily_bought: { reg: 520, type: 'u16', scale: 0.1 },
  daily_sold: { reg: 521, type: 'u16', scale: 0.1 },
  daily_battery_charge: { reg: 514, type: 'u16', scale: 0.1 },
  daily_battery_discharge: { reg: 515, type: 'u16', scale: 0.1 },
  total_production: { reg: 534, type: 'u32', scale: 0.1 },
  total_consumption: { reg: 527, type: 'u32', scale: 0.1 },
  total_bought: { reg: 522, type: 'u32', scale: 0.1 },
  total_sold: { reg: 524, type: 'u32', scale: 0.1 },
};

function round(value, scale) {
  // Avoid 52.300000000000004 from float scaling.
  const decimals = scale < 1 ? Math.round(-Math.log10(scale)) : 0;
  return Number(value.toFixed(decimals));
}

// regs: { address: value } of all registers read this poll.
function decode(regs) {
  const out = {};
  for (const name of Object.keys(FIELDS)) {
    const f = FIELDS[name];
    const lo = regs[f.reg];
    if (lo === undefined) throw new Error('Register ' + f.reg + ' missing for ' + name);
    let raw;
    if (f.type === 'u32') {
      raw = lo + regs[f.reg + 1] * 65536;
    } else if (f.type === 's16') {
      raw = lo >= 0x8000 ? lo - 0x10000 : lo;
    } else {
      raw = lo;
    }
    const scale = f.scale || 1;
    out[name] = round((raw - (f.offset || 0)) * scale, scale);
  }
  out.solar_power = out.pv1_power + out.pv2_power;

  // Reject frames that are clearly garbage instead of publishing them.
  // (Grid frequency is legitimately 0 during an outage, so it isn't checked.)
  if (out.battery_soc > 100) throw new Error('Implausible battery SOC ' + out.battery_soc);
  return out;
}

async function read(client) {
  const regs = {};
  for (const block of BLOCKS) {
    const values = await client.readHoldingRegisters(block.start, block.count);
    for (let i = 0; i < values.length; i++) regs[block.start + i] = values[i];
  }
  return decode(regs);
}

// Register 0 is the device type; registers 3..7 hold the inverter serial as ASCII.
async function identify(client) {
  const r = await client.readHoldingRegisters(0, 8);
  let serial = '';
  for (let i = 3; i < 8; i++) serial += String.fromCharCode(r[i] >> 8, r[i] & 0xff);
  return { deviceType: r[0], inverterSerial: serial.replace(/[^\x21-\x7e]/g, '') };
}

const DEVICE_TYPE = 0x0005;

module.exports = { BLOCKS, FIELDS, decode, read, identify, DEVICE_TYPE };
