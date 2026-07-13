"use strict";

import {AudioEngine as V5AudioEngine} from "./audio-engine-v5.js?base=4";

const SOUNDS = Object.freeze({
  seaReal: "https://raw.githubusercontent.com/yuryAB/Mermaid/a3cf430c92586e5f6934d9e9f77a51357f00af0c/Ester/Audio/Ambience/ambient_clear_water.mp3",
  motorboatReal: "https://raw.githubusercontent.com/yuryAB/Mermaid/a3cf430c92586e5f6934d9e9f77a51357f00af0c/Ester/Audio/World/boat_muffled_pass.mp3",
  pumpReal: "https://raw.githubusercontent.com/evilbocchi/eternal-empire/4a3865150d1a425da952a535285ab9b92fe4d55e/assets/sounds/HandCrank.mp3",
  warningReal: "https://raw.githubusercontent.com/dsheedes/cd_easytime/174ddc1e823d1aad54361988ea54c302c08b980a/html/sound/tsunami_siren.ogg",
  hullImpactReal: "https://raw.githubusercontent.com/Aurorastation/Aurora.3/b50f42f9d3981ff1b9158c87c08524c38e9a3be9/sound/machines/hatch_close1.ogg",
});

export class AudioEngine extends V5AudioEngine {
  constructor() {
    super();
    this.lastNavigationCueAt = 0;
  }

  async preload() {
    await super.preload();
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(SOUNDS).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
  }

  playExcerpt(name, options = {}) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const filter = this.ctx.createBiquadFilter();
    source.buffer = buffer;
    source.playbackRate.value = options.rate || 1;
    gain.gain.value = options.gain ?? 0.5;
    panner.pan.value = Math.max(-1, Math.min(1, options.pan || 0));
    filter.type = "lowpass";
    filter.frequency.value = options.lowpass || 18000;
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    const offset = Math.max(0, Math.min(buffer.duration - 0.05, options.offset || 0));
    const duration = Math.max(0.05, Math.min(buffer.duration - offset, options.duration || buffer.duration));
    source.start(0, offset, duration);
    return source;
  }

  update(view) {
    if (!this.ctx) return;

    for (const name of [
      "waterCalm", "waterWake", "engine", "pump", "seaV4", "hullV4", "wakeV4", "engineV4",
      "engineNew", "pumpNew", "seaPort", "seaStarboard", "bowWash",
    ]) this.stopLoop(name);

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);

    this.ensureLoop("seaReal", {
      gain: 0.115 + Math.min(0.08, speed / 180),
      rate: 0.985 + Math.min(0.025, speed / 600),
      lowpass: 9200,
      pan: 0,
    });

    if (!view.boat.engineStalled && view.phase === "playing") {
      this.ensureLoop("motorboatReal", {
        gain: 0.045 + load * 0.22,
        rate: 0.92 + load * 0.16,
        lowpass: 1450 + load * 1900,
        pan: 0,
      });
    } else this.stopLoop("motorboatReal");

    if (view.boat.pumpActive) {
      this.ensureLoop("pumpReal", {gain: 0.17, rate: 0.92, lowpass: 3200, pan: -0.16});
    } else this.stopLoop("pumpReal");
  }

  handle(events) {
    for (const event of events || []) {
      if ([
        "sonar", "hazard-ping", "turn", "turn-complete", "turn-progress", "proximity",
        "rope", "rope-progress", "rope-far", "rope-strain", "rescue-complete", "win",
        "ui-deny", "repair", "repair-complete", "hull-repair-start", "hull-repair-progress",
        "hull-repair-complete", "repair-blocked", "anchor",
      ].includes(event.type)) {
        super.handle([event]);
      } else if (event.type === "navigation-cue") {
        if (!this.ctx || this.ctx.currentTime - this.lastNavigationCueAt < 0.35) continue;
        this.lastNavigationCueAt = this.ctx.currentTime;
        const near = (event.distance || 999) < 28;
        this.play(near ? "sonarNear" : "sonar", {
          pan: event.pan || 0,
          gain: near ? 0.28 : 0.19,
          rate: near ? 1.12 : 0.9,
          lowpass: 5600,
        });
      } else if (event.type === "sonar-lock") {
        this.play("sonarNear", {pan: event.pan || 0, gain: 0.22, rate: 1.18, lowpass: 5800});
      } else if (event.type === "steer-no-flow") {
        this.play("rudderV4", {pan: event.pan || 0, gain: 0.3, rate: 0.68, lowpass: 3200});
      } else if (event.type === "collision") {
        this.play("hullImpactReal", {pan: event.pan || 0, gain: 0.72, rate: 0.92, lowpass: 5400});
      } else if (event.type === "warning") {
        this.playExcerpt("warningReal", {
          gain: event.critical ? 0.42 : 0.24,
          rate: event.critical ? 1 : 1.08,
          lowpass: event.critical ? 7200 : 5200,
          offset: 0.15,
          duration: event.critical ? 1.55 : 0.72,
        });
      } else if (event.type === "engine-stall" || event.type === "lose") {
        this.playExcerpt("warningReal", {gain: 0.48, rate: 0.94, lowpass: 7600, offset: 0.1, duration: 1.9});
      } else if (event.type === "pump-start") {
        this.playExcerpt("pumpReal", {gain: 0.24, rate: 0.94, lowpass: 3400, offset: 0, duration: 0.8});
      }
    }
  }
}
