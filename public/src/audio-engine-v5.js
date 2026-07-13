"use strict";

import {AudioEngine as V4AudioEngine} from "./audio-engine-v4.js?base=4";

const ROOT = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main/";

// Only verified files from the CC0 pack are listed here. Scenario cues are still
// delegated to v4 below; this layer replaces ambience, machinery and warnings.
const SOUND_FILES = Object.freeze({
  waterSoft: ROOT + "40-cc0-water-splash-slime-sfx/splash_02.ogg",
  waterSide: ROOT + "40-cc0-water-splash-slime-sfx/splash_04.ogg",
  waterBow: ROOT + "40-cc0-water-splash-slime-sfx/splash_08.ogg",
  waterHeavy: ROOT + "40-cc0-water-splash-slime-sfx/splash_10.ogg",
  engineNew: ROOT + "30-cc0-sfx-loops/machine_02.ogg",
  pumpNew: ROOT + "30-cc0-sfx-loops/pump_01.ogg",
  warningSoft: ROOT + "30-cc0-sfx-loops/alarm_01.ogg",
  warningCritical: ROOT + "30-cc0-sfx-loops/alarm_03.ogg",
  collisionNew: ROOT + "100-CC0-wood-metal-SFX/metal_hit_05.ogg",
  ropeNew: ROOT + "100-CC0-wood-metal-SFX/wood_hit_08.ogg",
  hullCreak: ROOT + "100-CC0-wood-metal-SFX/wood_hit_09.ogg",
  hullRepair: ROOT + "100-cc0-sfx-2/sfx100v2_metal_06.ogg",
});

const WATER_NAMES = Object.freeze(["waterSoft", "waterSide", "waterBow", "waterHeavy"]);

export class AudioEngine extends V4AudioEngine {
  constructor() {
    super();
    this.nextCreakAt = 0;
    this.nextWaterAt = 0;
    this.nextBowAt = 0;
    this.waterIndex = 0;
  }

  async preload() {
    await super.preload();
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(SOUND_FILES).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
  }

  nextWaterName() {
    const name = WATER_NAMES[this.waterIndex % WATER_NAMES.length];
    this.waterIndex += 1;
    return name;
  }

  playWaterGrain(speed, foreground = false) {
    const name = foreground && speed > 6 ? "waterHeavy" : this.nextWaterName();
    const movement = Math.min(1, speed / 14);
    this.play(name, {
      gain: foreground ? 0.12 + movement * 0.22 : 0.065 + movement * 0.095,
      pan: foreground ? Math.random() * 0.8 - 0.4 : Math.random() < 0.5 ? -0.72 : 0.72,
      rate: 0.84 + Math.random() * 0.18 + movement * 0.06,
      lowpass: foreground ? 7200 : 5000,
    });
  }

  update(view) {
    if (!this.ctx) return;

    // Stop every inherited ambient/mechanical loop. Scenario one-shots remain intact.
    for (const name of [
      "waterCalm", "waterWake", "engine", "seaV4", "hullV4", "wakeV4", "engineV4",
      "seaPort", "seaStarboard", "bowWash",
    ]) this.stopLoop(name);

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);
    const moving = speed > 0.2;

    // A recorded granular sea bed: varied water recordings instead of repeating the old loops.
    if (this.ctx.currentTime >= this.nextWaterAt) {
      this.playWaterGrain(speed, false);
      const idleGap = 1.65 + Math.random() * 1.35;
      const movingGap = Math.max(0.48, 1.35 - speed / 22) + Math.random() * 0.45;
      this.nextWaterAt = this.ctx.currentTime + (moving ? movingGap : idleGap);
    }

    // Additional bow wash only while the hull is actually moving.
    if (moving && this.ctx.currentTime >= this.nextBowAt) {
      this.playWaterGrain(speed, true);
      this.nextBowAt = this.ctx.currentTime + Math.max(0.72, 2.8 - speed / 7) + Math.random() * 0.7;
    }

    if (!view.boat.engineStalled && view.phase === "playing") {
      this.ensureLoop("engineNew", {
        gain: 0.05 + load * 0.24,
        rate: 0.84 + load * 0.25,
        lowpass: 1100 + load * 2100,
        pan: 0,
      });
    } else this.stopLoop("engineNew");

    if (view.boat.pumpActive) {
      this.ensureLoop("pumpNew", {gain: 0.21, rate: 0.94, lowpass: 2750, pan: -0.15});
    } else this.stopLoop("pumpNew");

    if (view.phase === "playing" && speed > 0.7 && this.ctx.currentTime >= this.nextCreakAt) {
      this.play("hullCreak", {
        gain: 0.075 + Math.min(0.1, speed / 130),
        pan: Math.random() * 1.25 - 0.625,
        rate: 0.74 + Math.random() * 0.17,
        lowpass: 3100,
      });
      this.nextCreakAt = this.ctx.currentTime + 6.5 + Math.random() * 9;
    }
  }

  handle(events) {
    for (const event of events || []) {
      // Preserve the established scenario/navigation cues.
      if ([
        "sonar", "hazard-ping", "turn", "turn-complete", "proximity",
        "rescue-complete", "win", "ui-deny", "repair", "repair-complete",
      ].includes(event.type)) {
        super.handle([event]);
      } else if (event.type === "turn-progress") {
        super.handle([{type: "turn", direction: event.direction, pan: event.pan}]);
      } else if (event.type === "collision") {
        this.play("collisionNew", {pan: event.pan || 0, gain: 0.82, rate: 0.9, lowpass: 5300});
        this.play("waterHeavy", {pan: event.pan || 0, gain: 0.58, rate: 0.82, lowpass: 6500});
      } else if (event.type === "rope" || event.type === "rope-progress") {
        this.play("ropeNew", {
          gain: event.type === "rope-progress" ? 0.22 : 0.48,
          rate: 0.82 + (event.percent || 0) / 500,
          lowpass: 4300,
        });
      } else if (event.type === "rope-far") {
        this.play("ropeNew", {gain: 0.23, rate: 0.66, lowpass: 3200});
      } else if (event.type === "rope-strain") {
        this.play("ropeNew", {gain: 0.47, rate: 1.15, lowpass: 4800});
      } else if (event.type === "anchor") {
        this.play("ropeNew", {gain: 0.41, rate: 0.72, lowpass: 4000});
        this.play("waterHeavy", {gain: 0.37, rate: 0.74, lowpass: 5900});
      } else if (event.type === "hull-repair-start" || event.type === "hull-repair-progress") {
        this.play("hullRepair", {gain: 0.3, rate: 0.82 + (event.percent || 0) / 600, lowpass: 4600});
      } else if (event.type === "hull-repair-complete") {
        this.play("hullRepair", {gain: 0.58, rate: 1.04, lowpass: 5200});
      } else if (event.type === "repair-blocked") {
        this.play("warningSoft", {gain: 0.34, rate: 0.78, lowpass: 4200});
      } else if (event.type === "warning") {
        this.play(event.critical ? "warningCritical" : "warningSoft", {
          gain: event.critical ? 0.64 : 0.4,
          rate: event.critical ? 0.9 : 1.02,
          lowpass: event.critical ? 6500 : 5200,
        });
      } else if (event.type === "engine-stall" || event.type === "lose") {
        this.play("warningCritical", {gain: 0.67, rate: 0.86, lowpass: 6500});
      } else if (event.type === "pump-start") {
        this.play("pumpNew", {gain: 0.27, rate: 0.92, lowpass: 2800});
      }
    }
  }
}
