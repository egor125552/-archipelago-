"use strict";

import {AudioEngine as V4AudioEngine} from "./audio-engine-v4.js?base=1";

const ROOT = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main/";
const candidates = Object.freeze({
  seaPort: [
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_05.ogg",
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_04.ogg",
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_02.ogg",
  ],
  seaStarboard: [
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_06.ogg",
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_04.ogg",
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_01.ogg",
  ],
  bowWash: [
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_04.ogg",
    ROOT + "40-cc0-water-splash-slime-sfx/loop_water_03.ogg",
  ],
  engineNew: [
    ROOT + "30-cc0-sfx-loops/machine_02.ogg",
    ROOT + "30-cc0-sfx-loops/machine_04.ogg",
    ROOT + "30-cc0-sfx-loops/machine_01.ogg",
  ],
  pumpNew: [
    ROOT + "30-cc0-sfx-loops/pump_01.ogg",
    ROOT + "30-cc0-sfx-loops/pump_03.ogg",
    ROOT + "30-cc0-sfx-loops/pump_02.ogg",
  ],
  warningSoft: [
    ROOT + "30-cc0-sfx-loops/alarm_01.ogg",
    ROOT + "50-cc0-sci-fi-sfx/terminal_02.ogg",
    ROOT + "30-cc0-sfx-loops/alarm_02.ogg",
  ],
  warningCritical: [
    ROOT + "30-cc0-sfx-loops/alarm_03.ogg",
    ROOT + "50-cc0-sci-fi-sfx/terminal_07.ogg",
    ROOT + "30-cc0-sfx-loops/alarm_02.ogg",
  ],
  collisionNew: [
    ROOT + "100-CC0-wood-metal-SFX/metal_hit_07.ogg",
    ROOT + "100-CC0-wood-metal-SFX/metal_hit_05.ogg",
    ROOT + "100-CC0-wood-metal-SFX/metal_hit_03.ogg",
  ],
  ropeNew: [
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_08.ogg",
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_06.ogg",
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_04.ogg",
  ],
  hullCreak: [
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_09.ogg",
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_02.ogg",
    ROOT + "100-CC0-wood-metal-SFX/wood_hit_04.ogg",
  ],
  hullRepair: [
    ROOT + "100-cc0-sfx-2/sfx100v2_metal_07.ogg",
    ROOT + "100-cc0-sfx-2/sfx100v2_metal_06.ogg",
    ROOT + "100-cc0-sfx-2/sfx100v2_metal_04.ogg",
  ],
});

export class AudioEngine extends V4AudioEngine {
  constructor() {
    super();
    this.nextCreakAt = 0;
    this.nextWashAt = 0;
  }

  async loadFirst(name, urls) {
    if (!this.ctx) return;
    for (const url of urls) {
      try {
        const response = await fetch(url, {mode: "cors", cache: "force-cache"});
        if (!response.ok) continue;
        const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(name, buffer);
        return;
      } catch (_) {}
    }
  }

  async preload() {
    await super.preload();
    await Promise.allSettled(Object.entries(candidates).map(([name, urls]) => this.loadFirst(name, urls)));
  }

  update(view) {
    if (!this.ctx) return;
    for (const name of [
      "waterCalm", "waterWake", "engine", "seaV4", "hullV4", "wakeV4", "engineV4",
    ]) this.stopLoop(name);

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);
    const moving = speed > 0.18;

    this.ensureLoop("seaPort", {gain: 0.105, rate: 0.91, lowpass: 6100, pan: -0.62});
    this.ensureLoop("seaStarboard", {gain: 0.095, rate: 1.035, lowpass: 6700, pan: 0.58});

    if (moving) {
      this.ensureLoop("bowWash", {
        gain: Math.min(0.29, 0.035 + speed / 72),
        rate: 0.78 + Math.min(0.32, speed / 52),
        lowpass: 5400 + Math.min(2200, speed * 100),
        pan: 0,
      });
    } else this.stopLoop("bowWash");

    if (!view.boat.engineStalled && view.phase === "playing") {
      this.ensureLoop("engineNew", {
        gain: 0.055 + load * 0.25,
        rate: 0.82 + load * 0.28,
        lowpass: 1050 + load * 2100,
        pan: 0,
      });
    } else this.stopLoop("engineNew");

    if (view.boat.pumpActive) {
      this.ensureLoop("pumpNew", {gain: 0.22, rate: 0.92, lowpass: 2600, pan: -0.15});
    } else this.stopLoop("pumpNew");

    if (speed > 2.5 && this.ctx.currentTime >= this.nextWashAt) {
      this.play("splash", {
        gain: Math.min(0.33, 0.11 + speed / 95),
        pan: Math.random() * 1.4 - 0.7,
        rate: 0.82 + Math.random() * 0.18,
        lowpass: 6500,
      });
      this.nextWashAt = this.ctx.currentTime + Math.max(1.6, 4.8 - speed / 7) + Math.random() * 1.8;
    }

    if (view.phase === "playing" && speed > 0.7 && this.ctx.currentTime >= this.nextCreakAt) {
      this.play("hullCreak", {
        gain: 0.09 + Math.min(0.12, speed / 120),
        pan: Math.random() * 1.3 - 0.65,
        rate: 0.72 + Math.random() * 0.2,
        lowpass: 3200,
      });
      this.nextCreakAt = this.ctx.currentTime + 5.5 + Math.random() * 8;
    }
  }

  handle(events) {
    for (const event of events || []) {
      if (["sonar", "hazard-ping", "turn", "turn-complete", "proximity", "rescue-complete", "win", "ui-deny", "repair", "repair-complete"].includes(event.type)) {
        super.handle([event]);
      } else if (event.type === "turn-progress") {
        super.handle([{type: "turn", direction: event.direction, pan: event.pan}]);
      } else if (event.type === "collision") {
        this.play("collisionNew", {pan: event.pan || 0, gain: 0.82, rate: 0.88, lowpass: 5200});
        this.play("splash", {pan: event.pan || 0, gain: 0.58, rate: 0.78, lowpass: 6200});
      } else if (event.type === "rope" || event.type === "rope-progress") {
        this.play("ropeNew", {gain: event.type === "rope-progress" ? 0.24 : 0.48, rate: 0.82 + (event.percent || 0) / 500, lowpass: 4300});
      } else if (event.type === "rope-far") {
        this.play("ropeNew", {gain: 0.24, rate: 0.66, lowpass: 3200});
      } else if (event.type === "rope-strain") {
        this.play("ropeNew", {gain: 0.48, rate: 1.16, lowpass: 4800});
      } else if (event.type === "anchor") {
        this.play("ropeNew", {gain: 0.42, rate: 0.72, lowpass: 4000});
        this.play("splash", {gain: 0.38, rate: 0.7, lowpass: 5800});
      } else if (event.type === "hull-repair-start" || event.type === "hull-repair-progress") {
        this.play("hullRepair", {gain: 0.3, rate: 0.82 + (event.percent || 0) / 600, lowpass: 4600});
      } else if (event.type === "hull-repair-complete") {
        this.play("hullRepair", {gain: 0.58, rate: 1.04, lowpass: 5200});
      } else if (event.type === "repair-blocked") {
        this.play("warningSoft", {gain: 0.35, rate: 0.78, lowpass: 4200});
      } else if (event.type === "warning") {
        this.play(event.critical ? "warningCritical" : "warningSoft", {
          gain: event.critical ? 0.66 : 0.42,
          rate: event.critical ? 0.9 : 1.02,
          lowpass: event.critical ? 6500 : 5200,
        });
      } else if (event.type === "engine-stall" || event.type === "lose") {
        this.play("warningCritical", {gain: 0.68, rate: 0.86, lowpass: 6500});
      } else if (event.type === "pump-start") {
        this.play("pumpNew", {gain: 0.28, rate: 0.9, lowpass: 2800});
      }
    }
  }
}
