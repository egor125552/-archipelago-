"use strict";

import {AudioEngine as V11AudioEngine} from "./audio-engine-v11.js?base=7";

export class AudioEngine extends V11AudioEngine {
  update(view) {
    super.update(view);
    if (!this.ctx || view.phase !== "playing" || view.boat.engineStalled || view.boat.modelId !== "grom") return;
    const load = Math.abs(view.boat.throttle || 0);
    this.ensureLoop("motorboatReal", {
      gain: 0.085 + load * 0.28,
      rate: 0.96 + load * 0.4,
      lowpass: 1450 + load * 2850,
      pan: 0,
    });
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "hunter-hit") {
        this.playMetalBurst({pan: event.pan || 0, gain: 0.2, duration: 0.34, frequency: 1040});
        this.playSynthPip({pan: event.pan || 0, frequency: 172, gain: 0.12, duration: 0.2});
      } else if (event.type === "hunter-destroyed") {
        this.playMetalBurst({pan: event.pan || 0, gain: 0.24, duration: 0.62, frequency: 650});
        this.playMetalBurst({pan: event.pan || 0, gain: 0.14, duration: 0.48, frequency: 1320});
        this.playSynthPip({pan: event.pan || 0, frequency: 128, gain: 0.15, duration: 0.45});
      } else {
        super.handle([event]);
      }
    }
  }
}
