'use strict';

const { Device } = require('homey');
const {
  SolarmanClient, findLoggers, isValidHost, isValidSerial,
} = require('../../lib/solarman');
const sg04lp3 = require('../../lib/sg04lp3');

// Consecutive failed polls before the device is marked unavailable.
const MAX_FAILURES = 3;
// While unavailable, look for the logger at a new IP at most this often.
const REDISCOVER_INTERVAL = 5 * 60 * 1000;

const CAPABILITIES = {
  'measure_power.solar': 'solar_power',
  'measure_power.battery': 'battery_power',
  'measure_power.grid': 'grid_power',
  'measure_power.load': 'load_power',
  battery_soc: 'battery_soc',
  'measure_temperature.battery': 'battery_temperature',
  'measure_temperature.inverter': 'inverter_temperature',
  'meter_power.production_today': 'daily_production',
  'meter_power.consumption_today': 'daily_consumption',
  'meter_power.bought_today': 'daily_bought',
  'meter_power.sold_today': 'daily_sold',
  'meter_power.charged_today': 'daily_battery_charge',
  'meter_power.discharged_today': 'daily_battery_discharge',
};

class Sg04lp3Device extends Device {

  async onInit() {
    this._failures = 0;
    this._timer = null;
    this._stopped = false;
    this._lastRediscover = 0;
    await this._migrateCapabilities();
    this._connect(this.getSettings());
    this._schedule(0);
  }

  // 1.0.0 used measure_battery, which makes Homey treat the device as running
  // on replaceable batteries (low-battery warnings at night).
  async _migrateCapabilities() {
    try {
      if (this.hasCapability('measure_battery')) await this.removeCapability('measure_battery');
      for (const capability of Object.keys(CAPABILITIES)) {
        if (!this.hasCapability(capability)) await this.addCapability(capability);
      }
    } catch (err) {
      this.error('Capability migration failed:', err.message);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!isValidHost(newSettings.host)) throw new Error(this.homey.__('pair.error.host'));
    if (!isValidSerial(newSettings.serial)) throw new Error(this.homey.__('pair.error.serial'));
    if (changedKeys.indexOf('host') >= 0 || changedKeys.indexOf('serial') >= 0) {
      this._connect(newSettings);
      this._failures = 0;
    }
    // Poll right away, after Homey has stored the new settings.
    this._schedule(1000);
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
  }

  _connect(settings) {
    if (this._client) this._client.close();
    this._client = null;
    try {
      this._client = new SolarmanClient({
        host: settings.host,
        serial: settings.serial,
        log: this.log.bind(this),
      });
    } catch (err) {
      this.error('Invalid settings:', err.message);
    }
  }

  _stop() {
    this._stopped = true;
    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = null;
    if (this._client) this._client.close();
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = this.homey.setTimeout(() => {
      this._timer = null;
      this._poll()
        .catch(err => this.error('Poll crashed:', err && err.stack ? err.stack : err))
        .then(() => {
          // onSettings may have scheduled a poll meanwhile.
          if (this._stopped || this._timer) return;
          let seconds = 10;
          try { seconds = Number(this.getSetting('poll_interval')) || 10; } catch (e) { /* deleted */ }
          this._schedule(Math.max(5, seconds) * 1000);
        });
    }, delayMs);
  }

  async _poll() {
    const client = this._client;
    if (!client) {
      await this._failed(new Error(this.homey.__('pair.error.serial')));
      return;
    }

    let data;
    try {
      data = await sg04lp3.read(client);
    } catch (err) {
      if (client !== this._client) return; // settings changed meanwhile
      client.reset(); // reconnect on the next poll
      await this._failed(err);
      return;
    }
    if (client !== this._client || this._stopped) return;

    this._failures = 0;
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);

    for (const capability of Object.keys(CAPABILITIES)) {
      const value = data[CAPABILITIES[capability]];
      if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(this.error);
      }
    }
    await this.driver.triggerDataUpdated(this, data);
  }

  async _failed(err) {
    this._failures++;
    this.error('Poll failed (' + this._failures + 'x):', err.message);
    if (this._failures < MAX_FAILURES) return;
    if (this.getAvailable()) await this.setUnavailable(err.message).catch(this.error);
    if (Date.now() - this._lastRediscover >= REDISCOVER_INTERVAL) {
      this._lastRediscover = Date.now();
      await this._rediscover().catch(e => this.error('Rediscovery failed:', e.message));
    }
  }

  // The logger may have got a new IP from DHCP: look for its serial on the LAN.
  async _rediscover() {
    const settings = this.getSettings();
    const serial = Number(String(settings.serial).trim());
    const loggers = await findLoggers(await this.homey.cloud.getLocalAddress(), this.log.bind(this));
    const match = loggers.filter(l => l.serial === serial)[0];
    if (!match) {
      this.log('Rediscovery: logger ' + serial + ' not found');
      return;
    }
    if (match.host === String(settings.host).trim() || this._stopped) return;
    this.log('Rediscovery: logger ' + serial + ' moved to ' + match.host);
    await this.setSettings({ host: match.host });
    this._connect(Object.assign({}, settings, { host: match.host }));
  }

}

module.exports = Sg04lp3Device;
