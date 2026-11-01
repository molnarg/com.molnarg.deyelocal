'use strict';

const Homey = require('homey');

class DeyeLocalApp extends Homey.App {

  async onInit() {
    this.log('Deye Inverter (Local) has been initialized');
  }

  getStatus() {
    const devices = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (typeof device.getStatus === 'function') devices.push(device.getStatus());
      }
    }
    return { now: new Date().toISOString(), devices };
  }

}

module.exports = DeyeLocalApp;
