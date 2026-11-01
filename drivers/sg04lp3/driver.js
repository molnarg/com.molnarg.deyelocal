'use strict';

const { Driver } = require('homey');
const {
  SolarmanClient, discover, scanPort, fetchLoggerSerial,
} = require('../../lib/solarman');
const sg04lp3 = require('../../lib/sg04lp3');

class Sg04lp3Driver extends Driver {

  async onInit() {
    this._dataUpdated = this.homey.flow.getDeviceTriggerCard('data_updated');
  }

  triggerDataUpdated(device, data) {
    return this._dataUpdated.trigger(device, {
      solar_power: data.solar_power,
      battery_power: data.battery_power,
      grid_power: data.grid_power,
      load_power: data.load_power,
      battery_soc: data.battery_soc,
    }).catch(err => this.error('Trigger failed:', err.message));
  }

  async _findLogger() {
    const loggers = await discover({ timeout: 2000 }).catch(() => []);
    this.log('UDP discovery:', JSON.stringify(loggers));
    if (loggers.length) return { host: loggers[0].host, serial: loggers[0].serial };

    const address = await this.homey.cloud.getLocalAddress(); // "192.168.31.21:80"
    const m = /^(\d+\.\d+\.\d+)\.\d+/.exec(address || '');
    if (!m) return null;
    const hosts = await scanPort({ prefix: m[1] });
    this.log('Hosts with port 8899 open in ' + m[1] + '.0/24:', JSON.stringify(hosts));
    for (const candidate of hosts) {
      const loggerSerial = await fetchLoggerSerial(candidate);
      if (loggerSerial) return { host: candidate, serial: loggerSerial };
    }
    return hosts.length ? { host: hosts[0], serial: null } : null;
  }

  async onPair(session) {
    let host = '';
    let serial = '';

    session.setHandler('set_host', async value => { host = String(value).trim(); });
    session.setHandler('set_serial', async value => { serial = String(value).trim(); });

    // Prefill the form: UDP discovery first, then a TCP 8899 scan of the
    // Homey's own /24 plus the serial from the logger's web page.
    session.setHandler('prefill', async () => {
      try {
        const found = await this._findLogger();
        this.log('Prefill:', JSON.stringify(found));
        if (!found) return null;
        host = found.host;
        serial = found.serial ? String(found.serial) : '';
        return { host, serial };
      } catch (err) {
        this.error('Prefill failed:', err.message);
        return null;
      }
    });

    session.setHandler('list_devices', async () => {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error(this.homey.__('pair.error.host'));
      if (!/^\d+$/.test(serial)) throw new Error(this.homey.__('pair.error.serial'));

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
