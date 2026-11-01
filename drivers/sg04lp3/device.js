'use strict';

const { Device } = require('homey');
const { SolarmanClient } = require('../../lib/solarman');
const sg04lp3 = require('../../lib/sg04lp3');

// Consecutive failed polls before the device is marked unavailable.
const MAX_FAILURES = 3;

const CAPABILITIES = {
  'measure_power.solar': 'solar_power',
  'measure_power.battery': 'battery_power',
  'measure_power.grid': 'grid_power',
  'measure_power.load': 'load_power',
  measure_battery: 'battery_soc',
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
    this._connect(this.getSettings());
    this._schedule(0);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.indexOf('host') >= 0 || changedKeys.indexOf('serial') >= 0) {
      if (!/^\d+$/.test(String(newSettings.serial).trim())) throw new Error(this.homey.__('pair.error.serial'));
      this._connect(newSettings);
    }
    this._schedule(0);
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
  }

  _connect(settings) {
    if (this._client) this._client.close();
    this._client = new SolarmanClient({
      host: String(settings.host).trim(),
      serial: String(settings.serial).trim(),
      log: this.log.bind(this),
    });
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
      this._poll().then(() => {
        const seconds = Math.max(5, Number(this.getSetting('poll_interval')) || 10);
        if (!this._timer) this._schedule(seconds * 1000);
      });
    }, delayMs);
  }

  async _poll() {
    let data;
    try {
      data = await sg04lp3.read(this._client);
    } catch (err) {
      this._failures++;
      this.error('Poll failed (' + this._failures + 'x):', err.message);
      this._client.close(); // reconnect on the next poll
      if (this._failures >= MAX_FAILURES && this.getAvailable()) {
        await this.setUnavailable(err.message).catch(this.error);
      }
      return;
    }

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

}

module.exports = Sg04lp3Device;
