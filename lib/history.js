'use strict';

// Rolling history of recent samples, for flow conditions like
// "surplus has been above 3000 W for the last 60 s".

const MAX_AGE = 15 * 60 * 1000; // longest window a condition card can ask for

class History {

  constructor() {
    this.samples = []; // { t, values: { surplus, solar, battery } }, oldest first
  }

  add(t, values) {
    this.samples.push({ t, values });
    while (this.samples.length && this.samples[0].t < t - MAX_AGE) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }

  // True only if, for the whole window [now - seconds, now]:
  //  - there is data: the history reaches back to the start of the window
  //    (within one poll interval, since samples are discrete),
  //  - there are no gaps longer than `maxGap` (the device was unavailable),
  //  - the newest sample is fresh (no older than `maxGap`),
  //  - every sample in the window is strictly above / below the threshold.
  holds({ now, key, comparison, threshold, seconds, pollInterval, maxGap }) {
    const samples = this.samples;
    if (!samples.length) return false;
    const windowStart = now - seconds * 1000;
    if (now - samples[samples.length - 1].t > maxGap) return false;
    if (samples[0].t > windowStart + pollInterval) return false;

    let previous = null;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (sample.t < windowStart) { previous = sample; continue; }
      if (previous && sample.t - previous.t > maxGap) return false;
      previous = sample;
      const value = sample.values[key];
      if (typeof value !== 'number' || !isFinite(value)) return false;
      if (comparison === 'above' ? !(value > threshold) : !(value < threshold)) return false;
    }
    return true;
  }

}

module.exports = { History, MAX_AGE };
