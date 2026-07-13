"use strict";

import {AudioEngine as V8AudioEngine} from "./audio-engine-v8.js?base=1";

const VELOREN_ROOT = "https://raw.githubusercontent.com/veloren/veloren/754dc94c4ef05e93e45f5870d6e1de0c2cbc93cc/assets/voxygen/audio/sfx/ambient/river_sounds/";
const RIVER_SOUNDS = Object.freeze({
  riverIdle: VELOREN_ROOT + "running_water-004.ogg",
  riverWake: VELOREN_ROOT + "running_water-019.ogg",
  bilgeWater: VELOREN_ROOT + "running_water-026.ogg",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class AudioEngine extends V8AudioEngine {
  constructor() {
    super();
    this.legacyLoopsCleared = false;
  }

  async preload() {
    await super.preload();
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(RIVER_SOUNDS).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
  }

  clearInheritedLoopsOnce() {
    if (this.legacyLoopsCleared) return;
    this.legacyLoopsCleared = true;
    for (const name of [
      "waterCalm", "waterWake", "rain", "engine", "pump", "seaV4", "hullV4", "wakeV4", "engineV4",
      "engineNew", "pumpNew", "seaPort", "seaStarboard", "bowWash", "seaReal", "motorboatReal", "pumpReal",
    ]) this.stopLoop(name);
  }

  update(view) {
    if (!this.ctx) return;
    this.clearInheritedLoopsOnce();

    const riverReady = this.buffers.has("riverIdle") && this.buffers.has("riverWake") && this.buffers.has("bilgeWater");
    if (riverReady) this.stopLoop("seaReal");

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);
    const water = clamp(Number(view.boat.water) || 0, 0, 100);
    const leak = clamp(Number(view.boat.leak) || 0, 0, 16);
    const playing = view.phase === "playing";
    const moving = speed >= 0.35;

    if (playing) {
      const idleName = this.buffers.has("riverIdle") ? "riverIdle" : "seaReal";
      this.ensureLoop(idleName, {
        gain: moving ? 0.022 : 0.038,
        rate: moving ? 0.96 : 0.91,
        lowpass: moving ? 3500 : 2550,
        pan: Math.sin(this.ctx.currentTime * 0.52) * 0.11,
      });

      if (moving) {
        const wakeName = this.buffers.has("riverWake") ? "riverWake" : "seaReal";
        const movement = clamp((speed - 0.25) / 10, 0, 1);
        this.ensureLoop(wakeName, {
          gain: 0.05 + movement * 0.25,
          rate: 0.84 + movement * 0.19,
          lowpass: 4300 + movement * 3600,
          pan: 0,
        });
      } else {
        this.stopLoop("riverWake");
      }

      if (!view.boat.engineStalled) {
        this.ensureLoop("motorboatReal", {
          gain: 0.06 + load * 0.22,
          rate: 0.9 + load * 0.17,
          lowpass: 1500 + load * 2100,
          pan: 0,
        });
      } else this.stopLoop("motorboatReal");

      if (water > 0.7 || leak > 0.05) {
        const openness = clamp(water / 72, 0, 1);
        const bilgeName = this.buffers.has("bilgeWater") ? "bilgeWater" : "seaReal";
        this.ensureLoop(bilgeName, {
          gain: 0.012 + openness * 0.245 + Math.min(0.045, leak / 260),
          rate: 0.78 + openness * 0.16,
          lowpass: 420 + openness * 7900,
          pan: -0.12 + Math.sin(this.ctx.currentTime * 0.37) * 0.08,
        });
      } else {
        this.stopLoop("bilgeWater");
      }

      if (view.boat.pumpActive) {
        this.ensureLoop("pumpReal", {gain: 0.18, rate: 0.93, lowpass: 3300, pan: -0.16});
      } else this.stopLoop("pumpReal");
    } else {
      for (const name of ["riverIdle", "riverWake", "bilgeWater", "seaReal", "motorboatReal", "pumpReal"]) this.stopLoop(name);
    }

    if (playing) {
      this.playGuide(view);
      this.playHazardGuide(view);
    }
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "motion-start") {
        this.playExcerpt(this.buffers.has("riverWake") ? "riverWake" : "seaReal", {
          gain: 0.14,
          rate: 0.9,
          lowpass: 6000,
          offset: 0.1,
          duration: 0.72,
        });
      } else if (event.type === "motion-stop") {
        this.playExcerpt(this.buffers.has("riverIdle") ? "riverIdle" : "seaReal", {
          gain: 0.105,
          rate: 0.9,
          lowpass: 3000,
          offset: 0.05,
          duration: 0.65,
        });
      } else if (event.type === "flood-emergency-start") {
        this.playExcerpt("warningReal", {gain: 0.46, rate: 0.94, lowpass: 7200, offset: 0.1, duration: 1.45});
        this.playSynthPip({frequency: 360, gain: 0.1, duration: 0.16, delay: 0.2});
      } else if (event.type === "flood-emergency-warning") {
        this.playSynthPip({frequency: event.critical ? 230 : 310, gain: event.critical ? 0.13 : 0.09, duration: 0.18});
      } else if (event.type === "flood-emergency-recovered") {
        this.playSynthPip({frequency: 540, gain: 0.075, duration: 0.1});
        this.playSynthPip({frequency: 720, gain: 0.08, duration: 0.1, delay: 0.16});
      } else if (event.type === "flood-emergency-failed") {
        this.playExcerpt("warningReal", {gain: 0.52, rate: 0.9, lowpass: 7600, offset: 0.1, duration: 1.85});
      } else if (event.type === "safety-brake") {
        this.playSynthPip({pan: event.pan || 0, frequency: 300, gain: 0.075, duration: 0.11});
      } else if (event.type === "safety-toggle") {
        this.playSynthPip({frequency: event.enabled ? 610 : 410, gain: 0.065, duration: 0.08});
      } else {
        super.handle([event]);
      }
    }
  }
}
