"use strict";

import {AudioEngine as V10AudioEngine} from "./audio-engine-v10.js?base=6";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class AudioEngine extends V10AudioEngine {
  constructor() {
    super();
    this.hunterEngine = null;
  }

  playMetalBurst({pan = 0, gain = 0.12, duration = 0.24, frequency = 1180} = {}) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      const fade = Math.pow(1 - index / length, 2.6);
      data[index] = (Math.random() * 2 - 1) * fade;
    }
    const source = this.ctx.createBufferSource();
    const band = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();
    const envelope = this.ctx.createGain();
    band.type = "bandpass";
    band.frequency.value = frequency;
    band.Q.value = 0.75;
    panner.pan.value = clamp(pan, -1, 1);
    envelope.gain.value = gain;
    source.buffer = buffer;
    source.connect(band).connect(panner).connect(envelope).connect(this.master);
    source.start();
  }

  startHunterEngine() {
    if (this.hunterEngine || !this.ctx || !this.master) return;
    const low = this.ctx.createOscillator();
    const pulse = this.ctx.createOscillator();
    const lowGain = this.ctx.createGain();
    const pulseGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();
    const gain = this.ctx.createGain();
    low.type = "sawtooth";
    pulse.type = "square";
    low.frequency.value = 46;
    pulse.frequency.value = 92;
    lowGain.gain.value = 0.72;
    pulseGain.gain.value = 0.12;
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 1.1;
    gain.gain.value = 0.0001;
    low.connect(lowGain).connect(filter);
    pulse.connect(pulseGain).connect(filter);
    filter.connect(panner).connect(gain).connect(this.master);
    low.start();
    pulse.start();
    this.hunterEngine = {low, pulse, filter, panner, gain};
  }

  stopHunterEngine() {
    if (!this.hunterEngine) return;
    try { this.hunterEngine.low.stop(); } catch (_) {}
    try { this.hunterEngine.pulse.stop(); } catch (_) {}
    this.hunterEngine = null;
  }

  updateHunterEngine(view) {
    if (!this.ctx || view.phase !== "playing" || !view.hunter?.active) {
      this.stopHunterEngine();
      return;
    }
    this.startHunterEngine();
    const engine = this.hunterEngine;
    if (!engine) return;
    const distance = Math.max(1, Number(view.hunter.distance) || 200);
    const proximity = clamp(1 - distance / 170, 0.03, 1);
    const speed = clamp((Number(view.hunter.speed) || 0) / 21, 0, 1);
    const at = this.ctx.currentTime;
    engine.low.frequency.setTargetAtTime(39 + speed * 24, at, 0.18);
    engine.pulse.frequency.setTargetAtTime(78 + speed * 48, at, 0.18);
    engine.filter.frequency.setTargetAtTime(360 + proximity * 820 + speed * 260, at, 0.18);
    engine.panner.pan.setTargetAtTime(clamp(view.hunter.pan || 0, -1, 1), at, 0.12);
    engine.gain.gain.setTargetAtTime(0.012 + proximity * 0.13, at, 0.18);
  }

  update(view) {
    super.update(view);
    if (!this.ctx || view.phase !== "playing") {
      this.stopHunterEngine();
      return;
    }
    const load = Math.abs(view.boat.throttle || 0);
    if (!view.boat.engineStalled && view.boat.modelId === "burevestnik") {
      this.ensureLoop("motorboatReal", {
        gain: 0.065 + load * 0.24,
        rate: 1.08 + load * 0.24,
        lowpass: 1780 + load * 2550,
        pan: 0,
      });
    } else if (!view.boat.engineStalled && view.boat.modelId === "grom") {
      this.ensureLoop("motorboatReal", {
        gain: 0.085 + load * 0.27,
        rate: 0.82 + load * 0.22,
        lowpass: 1320 + load * 2150,
        pan: 0,
      });
    }
    this.updateHunterEngine(view);
  }

  stopAll() {
    this.stopHunterEngine();
    super.stopAll();
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "wreck-crack") {
        this.playMetalBurst({pan: event.pan || 0, gain: 0.13, duration: 0.2, frequency: 980});
        this.playSynthPip({pan: event.pan || 0, frequency: 165, gain: 0.1, duration: 0.13});
      } else if (event.type === "wreck-destroyed") {
        this.playMetalBurst({pan: event.pan || 0, gain: 0.18, duration: 0.48, frequency: 720});
        this.playMetalBurst({pan: event.pan || 0, gain: 0.12, duration: 0.34, frequency: 1480});
        this.playSynthPip({pan: event.pan || 0, frequency: 132, gain: 0.12, duration: 0.2});
      } else if (event.type === "debris-embedded") {
        this.playMetalBurst({pan: event.pan || 0, gain: 0.16, duration: 0.42, frequency: 1860});
        this.playSynthPip({pan: event.pan || 0, frequency: 220, gain: 0.11, duration: 0.22});
      } else if (event.type === "debris-remove-start") {
        this.playMetalBurst({gain: 0.07, duration: 0.12, frequency: 1540});
      } else if (event.type === "debris-remove-progress") {
        this.playMetalBurst({gain: 0.055, duration: 0.08, frequency: 1200 + (event.percent || 0) * 5});
      } else if (event.type === "debris-remove-complete") {
        this.playMetalBurst({gain: 0.1, duration: 0.2, frequency: 1840});
        this.playSynthPip({frequency: 560, gain: 0.07, duration: 0.08, delay: 0.08});
      } else if (event.type === "debris-remove-cancel") {
        this.playSynthPip({frequency: 250, gain: 0.075, duration: 0.12});
      } else if (event.type === "hunter-ram") {
        super.handle([{type: "collision", pan: event.pan || 0, severity: 1.4}]);
        this.playMetalBurst({pan: event.pan || 0, gain: 0.2, duration: 0.46, frequency: 820});
        this.playSynthPip({pan: event.pan || 0, frequency: 118, gain: 0.14, duration: 0.3});
      } else if (event.type === "hunter-decoy") {
        this.playSynthPip({frequency: 1140, gain: 0.085, duration: 0.07});
        this.playSynthPip({frequency: 930, gain: 0.08, duration: 0.07, delay: 0.12});
        this.playSynthPip({frequency: 1140, gain: 0.075, duration: 0.07, delay: 0.24});
      } else if (event.type === "hunter-bearing") {
        // The continuous low spatial motor already carries this bearing.
      } else {
        super.handle([event]);
      }
    }
  }
}
