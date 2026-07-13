"use strict";

import {AudioEngine as V9AudioEngine} from "./audio-engine-v9.js?base=2";

export class AudioEngine extends V9AudioEngine {
  update(view) {
    super.update(view);
    if (!this.ctx || view.phase !== "playing" || view.boat?.modelId !== "kasatka" || view.boat.engineStalled) return;
    const load = Math.abs(view.boat.throttle || 0);
    this.ensureLoop("motorboatReal", {
      gain: 0.075 + load * 0.2,
      rate: 0.72 + load * 0.13,
      lowpass: 1180 + load * 1550,
      pan: 0,
    });
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "auto-stop") {
        this.playSynthPip({frequency: 430, gain: 0.07, duration: 0.09});
        this.playSynthPip({frequency: 310, gain: 0.065, duration: 0.11, delay: 0.15});
      } else if (event.type === "operation-reward") {
        this.playSynthPip({frequency: 660, gain: 0.075, duration: 0.08});
        this.playSynthPip({frequency: 830, gain: 0.08, duration: 0.09, delay: 0.13});
        this.playSynthPip({frequency: 1030, gain: 0.075, duration: 0.1, delay: 0.27});
      } else if (event.type === "collision" && event.absorbed > 0) {
        super.handle([event]);
        this.playSynthPip({pan: event.pan || 0, frequency: 1280, gain: 0.08, duration: 0.055, delay: 0.05});
      } else {
        super.handle([event]);
      }
    }
  }
}
