'use strict';

const { Device } = require('homey');
const {
  SolarmanClient, findLoggers, isValidHost, isValidSerial,
} = require('../../lib/solarman');
const sg04lp3 = require('../../lib/sg04lp3');
const { History } = require('../../lib/history');

// Consecutive failed polls before the device is marked unavailable.
const MAX_FAILURES = 3;
// While unavailable, look for the logger at a new IP at most this often.
const REDISCOVER_INTERVAL = 5 * 60 * 1000;

const CAPABILITIES = {
  'measure_power.solar': 'solar_power',
  'measure_power.battery': 'battery_power',
  'measure_power.grid': 'grid_power',
  'measure_power.load': 'load_power',
  'measure_power.surplus': 'surplus',
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
    this._history = new History();
    this._offset = Number(this.getStoreValue('surplus_offset')) || 0;
    this._events = []; // recent notable events, for the status API
    this._stats = { ok: 0, failed: 0, slowestMs: 0, startedAt: Date.now() };
    this._event('init', 'offset ' + this._offset);
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
    const started = Date.now();
    try {
      data = await sg04lp3.read(client);
    } catch (err) {
      if (client !== this._client) return; // settings changed meanwhile
      client.reset(); // reconnect on the next poll
      await this._failed(err);
      return;
    }
    if (client !== this._client || this._stopped) return;
    const took = Date.now() - started;
    this._stats.ok++;
    if (took > this._stats.slowestMs) this._stats.slowestMs = took;
    if (took > 3000) this._event('slow', 'read took ' + took + ' ms');

    this._failures = 0;
    if (!this.getAvailable()) {
      this._event('available', '');
      await this.setAvailable().catch(this.error);
    }

    // Surplus: power the house isn't using (battery charging + grid export),
    // plus an offset set from flows (e.g. while the battery is nearly full).
    data.surplus = Math.round(-data.battery_power - data.grid_power + this._offset);
    this._history.add(Date.now(), {
      surplus: data.surplus,
      solar: data.solar_power,
      battery: data.battery_soc,
    });

    for (const capability of Object.keys(CAPABILITIES)) {
      const value = data[CAPABILITIES[capability]];
      if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(this.error);
      }
    }
    await this.driver.triggerDataUpdated(this, data);
  }

  // Flow card handlers (registered in driver.js).

  async setSurplusOffset(offset) {
    const value = Number(offset);
    if (!isFinite(value)) throw new Error('Invalid offset');
    if (value === this._offset) return;
    this._event('offset', this._offset + ' -> ' + value);
    this._offset = value;
    await this.setStoreValue('surplus_offset', value);
  }

  restartHistory() {
    this._event('restart_history', this._history.samples.length + ' samples dropped');
    this._history.clear();
  }

  _event(type, message) {
    this.log('[' + type + ']', message);
    this._events.push({ t: new Date().toISOString(), type, message });
    if (this._events.length > 100) this._events.shift();
  }

  getStatus() {
    const samples = this._history.samples;
    let maxGap = 0;
    for (let i = 1; i < samples.length; i++) maxGap = Math.max(maxGap, samples[i].t - samples[i - 1].t);
    const iso = t => (t ? new Date(t).toISOString() : null);
    return {
      name: this.getName(),
      available: this.getAvailable(),
      host: this.getSetting('host'),
      pollInterval: this.getSetting('poll_interval'),
      offset: this._offset,
      failuresInARow: this._failures,
      stats: Object.assign({}, this._stats, { startedAt: iso(this._stats.startedAt) }),
      history: {
        samples: samples.length,
        first: iso(samples.length ? samples[0].t : 0),
        last: iso(samples.length ? samples[samples.length - 1].t : 0),
        maxGapMs: maxGap,
        latest: samples.length ? samples[samples.length - 1].values : null,
      },
      events: this._events.slice(-50),
    };
  }

  valueHeld({ quantity, comparison, threshold, seconds }) {
    const pollInterval = Math.max(5, Number(this.getSetting('poll_interval')) || 10) * 1000;
    return this._history.holds({
      now: Date.now(),
      key: quantity,
      comparison,
      threshold: Number(threshold),
      seconds: Number(seconds),
      pollInterval,
      // Tolerate one missed poll; more means the data has a hole.
      maxGap: 2 * pollInterval + 5000,
    });
  }

  async _failed(err) {
    this._failures++;
    this._stats.failed++;
    this._event('poll_failed', '(' + this._failures + 'x) ' + err.message);
    if (this._failures < MAX_FAILURES) return;
    if (this.getAvailable()) {
      this._event('unavailable', err.message);
      await this.setUnavailable(err.message).catch(this.error);
    }
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
    this._event('rediscovered', 'logger ' + serial + ' moved to ' + match.host);
    await this.setSettings({ host: match.host });
    this._connect(Object.assign({}, settings, { host: match.host }));
  }

}

module.exports = Sg04lp3Device;
