# Deye Inverter (Local)

Homey app that reads a Deye inverter over the LAN through its Solarman Wi-Fi
logger stick (Solarman V5 protocol, TCP port 8899). It needs no cloud
connection and polls every 10 seconds by default, compared with the 5-minute
cloud upload.

It is written in plain JavaScript for Node 12, so it runs on the **Homey Pro
(Early 2019)**. The existing local Deye app (`gpm.deye.solarpanel.tcp`) is a
Python app, and Python apps only run on Homey Pro 2023 and later.

## Supported inverters

Only Deye **three-phase low-voltage hybrids (SG04LP3)** so far, e.g.
SUN-5K…12K-SG04LP3-EU, which report device type `0x0005` in register 0.
Pairing checks this and refuses other models.

## Device

| Capability | Source | Notes |
|---|---|---|
| Solar power | PV1 + PV2 (regs 672, 673) | W |
| Battery power | reg 590 | W, **negative = charging**, positive = discharging |
| Grid power | reg 625 | W, positive = importing, **negative = exporting** |
| Load power | reg 653 | W |
| Battery | reg 588 | SOC % |
| Battery / inverter temperature | regs 586, 541 | °C |
| Production / consumption / bought / sold / charged / discharged today | regs 529, 526, 520, 521, 514, 515 | kWh |

The sign conventions are Deye's own, the same as in the `com.heszi.deye` cloud
app, so existing flow formulas keep working.

Flow trigger **Measured data updated** fires after every successful read, with
tokens for solar, battery, grid and load power and battery SOC.

After 3 failed reads in a row the device is marked unavailable. It becomes
available again on the next successful read.

## Pairing

Add a device and pick "Deye Hybrid Inverter (3-phase)". The app looks for
loggers with UDP discovery (port 48899) and prefills the form. Otherwise enter:

- the logger's **IP address**
- the **logger serial number**: the stick's serial, not the inverter's. It is
  on the stick's label and on its web page (Device serial number).

Both, plus the poll interval (5–300 s), can be changed later in the device
settings.

## Development

```sh
npm test                                              # offline unit tests (Node >= 18)
node scripts/read.js <logger-ip> <logger-serial> [s]  # read live from the dev machine
node scripts/read.js discover                         # UDP discovery
homey app validate --level publish
homey app install                                     # sideload to the selected Homey
```

Keep the code ES2019 (no `?.` or `??`): the Early 2019 Homey runs Node 12.

## Credits

Register addresses and scaling for the SG04LP3 come from
[gpmachado/gpm.deye.solarpanel.tcp](https://github.com/gpmachado/gpm.deye.solarpanel.tcp)
(MIT License, Copyright (c) 2026 Gabriel Pedrosa Machado), which builds on
[StephanJoubert/home_assistant_solarman](https://github.com/StephanJoubert/home_assistant_solarman)
(Apache-2.0). The Solarman V5 framing follows
[jmccrohan/pysolarmanv5](https://github.com/jmccrohan/pysolarmanv5) (MIT).
