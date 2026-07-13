"use strict";

import {AudioEngine as V12AudioEngine} from "./audio-engine-v12.js?base=8";

export class AudioEngine extends V12AudioEngine {
  handle(events) {
    for (const event of events || []) {
      if (event.type === "collision" && event.shore) {
        super.handle([{...event, severity: Math.max(1.8, event.severity || 0)}]);
        this.playMetalBurst({pan: event.pan || 0, gain: 0.26, duration: 0.58, frequency: 430});
        this.playSynthPip({pan: event.pan || 0, frequency: 72, gain: 0.18, duration: 0.42});
      } else if (event.type === "fuel-empty-ready") {
        this.playSynthPip({frequency: 186, gain: 0.1, duration: 0.16});
        this.playSynthPip({frequency: 142, gain: 0.1, duration: 0.2, delay: 0.2});
      } else if (event.type === "fuel-refuel-start") {
        this.playSynthPip({frequency: 420, gain: 0.065, duration: 0.09});
      } else if (event.type === "fuel-refuel-progress") {
        this.playSynthPip({frequency: 420 + (event.percent || 0) * 3, gain: 0.055, duration: 0.07});
      } else if (event.type === "fuel-refuel-complete") {
        this.playSynthPip({frequency: 540, gain: 0.075, duration: 0.1});
        this.playSynthPip({frequency: 720, gain: 0.07, duration: 0.12, delay: 0.12});
      } else if (event.type === "fuel-refuel-cancel") {
        this.playSynthPip({frequency: 210, gain: 0.07, duration: 0.12});
      } else {
        super.handle([event]);
      }
    }
  }
}
