'use strict';

// GET /api/app/com.molnarg.deyelocal/status: health of each inverter device
// (poll stats, history span and largest gap, recent events).
module.exports = {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },
};
