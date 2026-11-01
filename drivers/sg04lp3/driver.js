'use strict';

const { Driver } = require('homey');
const {
  SolarmanClient, findLoggers, isValidHost, isValidSerial,
} = require('../../lib/solarman');
const sg04lp3 = require('../../lib/sg04lp3');

class Sg04lp3Driver extends Driver {

  async onInit() {
    this._dataUpdated = this.homey.flow.getDeviceTriggerCard('data_updated');
    this.homey.flow.getConditionCard('value_held')
      .registerRunListener(async args => args.device.valueHeld(args));
    this.homey.flow.getActionCard('set_surplus_offset')
      .registerRunListener(async args => args.device.setSurplusOffset(args.offset));
    this.homey.flow.getActionCard('restart_history')
      .registerRunListener(async args => args.device.restartHistory());
  }

  triggerDataUpdated(device, data) {
    return this._dataUpdated.trigger(device, {
      solar_power: data.solar_power,
      battery_power: data.battery_power,
      grid_power: data.grid_power,
      load_power: data.load_power,
      battery_soc: data.battery_soc,
      surplus: data.surplus,
    }).catch(err => this.error('Trigger failed:', err.message));
  }

  async onPair(session) {
    let host = '';
    let serial = '';

    // The view sends both fields together right before moving on (see
    // pair/address.html), so list_devices always sees what's on screen.
    session.setHandler('set_address', async value => {
      const h = String(value && value.host || '').trim();
      const s = String(value && value.serial || '').trim();
      if (!isValidHost(h)) throw new Error(this.homey.__('pair.error.host'));
      if (!isValidSerial(s)) throw new Error(this.homey.__('pair.error.serial'));
      host = h;
      serial = s;
    });

    // Suggest a logger: UDP discovery, else a TCP 8899 scan of the Homey's /24
    // plus the serial from the logger's web page. Only a suggestion: the view
    // fills empty fields with it.
    session.setHandler('prefill', async () => {
      try {
        const loggers = await findLoggers(await this.homey.cloud.getLocalAddress(), this.log.bind(this));
        const best = loggers.filter(l => l.serial)[0] || loggers[0];
        this.log('Prefill:', JSON.stringify(best || null));
        return best ? { host: best.host, serial: best.serial ? String(best.serial) : '' } : null;
      } catch (err) {
        this.error('Prefill failed:', err.message);
        return null;
      }
    });

    session.setHandler('list_devices', async () => {
      if (!isValidHost(host)) throw new Error(this.homey.__('pair.error.host'));
      if (!isValidSerial(serial)) throw new Error(this.homey.__('pair.error.serial'));

      const client = new SolarmanClient({ host, serial, log: this.log.bind(this) });
      try {
        const info = await sg04lp3.identify(client);
        this.log('Identified inverter', JSON.stringify(info));
        if (info.deviceType !== sg04lp3.DEVICE_TYPE) {
          throw new Error(this.homey.__('pair.error.type', { type: '0x' + info.deviceType.toString(16) }));
        }
        await sg04lp3.read(client); // make sure a full read works too
        return [{
          name: 'Deye ' + info.inverterSerial,
          data: { id: info.inverterSerial },
          settings: { host, serial, poll_interval: 10 },
        }];
      } catch (err) {
        this.error('Pairing failed:', err.message);
        throw err;
      } finally {
        client.close();
      }
    });
  }

}

module.exports = Sg04lp3Driver;
