'use strict';

const Homey = require('homey');

class DeyeLocalApp extends Homey.App {

  async onInit() {
    this.log('Deye Inverter (Local) has been initialized');
  }

}

module.exports = DeyeLocalApp;
