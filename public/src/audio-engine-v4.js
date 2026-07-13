"use strict";

import {AudioEngine as BaseAudioEngine} from "./audio-engine.js?base=5";

const ROOT = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main/";
const EXTRA_SOUNDS = Object.freeze({
  seaV4: ROOT + "40-cc0-water-splash-slime-sfx/loop_water_03.ogg",
  hullV4: ROOT + "40-cc0-water-splash-slime-sfx/loop_water_01.ogg",
  wakeV4: ROOT + "40-cc0-water-splash-slime-sfx/loop_water_02.ogg",
  engineV4: ROOT + "30-cc0-sfx-loops/machine_03.ogg",
  rudderV4: ROOT + "100-CC0-wood-metal-SFX/wood_hit_04.ogg",
  hazardV4: ROOT + "50-cc0-sci-fi-sfx/terminal_04.ogg",
});

export class AudioEngine extends BaseAudioEngine {
  constructor() {
    super();
    this.nextHullSplashAt = 0;
  }

  async preload() {
    await super.preload();
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(EXTRA_SOUNDS).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      this.buffers.set(name, await this.ctx.decodeAudioData(await response.arrayBuffer()));
    }));
  }

  update(view) {
    if (!this.ctx) return;
    // Stop the older, brighter mix if it was started by a cached version.
    for (const name of ["waterCalm", "waterWake", "engine"]) this.stopLoop(name);

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);
    this.ensureLoop("seaV4", {
      gain: 0.15,
      rate: 0.98,
      lowpass: 7600,
      pan: -0.08,
    });
    this.ensureLoop("hullV4", {
      gain: 0.08 + Math.min(0.11, speed / 105),
      rate: 0.97 + Math.min(0.05, speed / 180),
      lowpass: 4300,
      pan: 0.1,
    });
    this.ensureLoop("wakeV4", {
      gain: Math.min(0.31, speed / 62),
      rate: 0.98 + Math.min(0.08, speed / 120),
      lowpass: 6800,
    });
    this.ensureLoop("rain", {gain: 0.025, rate: 1, lowpass: 8200});

    if (!view.boat.engineStalled && view.phase === "playing") {
      this.ensureLoop("engineV4", {
        gain: 0.07 + load * 0.24,
        rate: 0.9 + load * 0.18,
        lowpass: 1350 + load * 1750,
        pan: 0,
      });
    } else this.stopLoop("engineV4");

    if (view.boat.pumpActive) this.ensureLoop("pump", {gain: 0.22, rate: 0.98, lowpass: 2800});
    else this.stopLoop("pump");

    // Sparse recorded splashes; the continuous sea should remain readable.
    if (speed > 5 && this.ctx.currentTime >= this.nextHullSplashAt) {
      this.play("splash", {
        gain: Math.min(0.34, 0.12 + speed / 90),
        pan: Math.random() * 1.2 - 0.6,
        rate: 0.94 + Math.random() * 0.1,
        lowpass: 7200,
      });
      this.nextHullSplashAt = this.ctx.currentTime + Math.max(1.8, 4.3 - speed / 8) + Math.random() * 1.5;
    }
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "sonar") {
        const name = event.distance < 28 ? "sonarNear" : "sonar";
        this.play(name, {pan: event.pan || 0, gain: 0.62, rate: Math.max(0.82, 1.28 - event.distance / 220)});
      } else if (event.type === "hazard-ping") {
        this.play("hazardV4", {pan: event.pan || 0, gain: 0.48, rate: 0.72, lowpass: 3600});
      } else if (event.type === "turn") {
        this.play("rudderV4", {pan: event.pan || 0, gain: 0.42, rate: event.direction === "left" ? 0.88 : 1.05, lowpass: 4100});
      } else if (event.type === "turn-complete") {
        this.play("rudderV4", {pan: event.pan || 0, gain: 0.28, rate: 1.18, lowpass: 4500});
      } else if (event.type === "proximity") {
        const urgency = Math.max(0, 1 - (event.distance || 30) / 30);
        this.play("hazardV4", {pan: event.pan || 0, gain: 0.32 + urgency * 0.28, rate: 0.82 + urgency * 0.18, lowpass: 4200});
      } else if (event.type === "collision") {
        this.play("collision", {pan: event.pan || 0, gain: 0.9, lowpass: 5600});
        this.play("splash", {pan: event.pan || 0, gain: 0.66, rate: 0.96});
      } else if (event.type === "rope") this.play("rope", {gain: 0.58, lowpass: 5200});
      else if (event.type === "anchor") {
        this.play("rope", {gain: 0.46, rate: 0.86});
        this.play("splash", {gain: 0.42, rate: 0.9});
      } else if (event.type === "rescue-complete") this.play("rescue", {gain: 0.7});
      else if (event.type === "repair" || event.type === "repair-complete") this.play("repair", {gain: 0.55});
      else if (event.type === "win") this.play("win", {gain: 0.82});
      else if (event.type === "engine-stall" || event.type === "lose" || event.type === "warning") {
        this.play("warning", {gain: event.critical ? 0.7 : 0.48, rate: event.critical ? 0.94 : 1.02});
      } else if (event.type === "ui-deny") this.play("deny", {gain: 0.62, rate: 0.94});
    }
  }
}
