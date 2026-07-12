"use strict";

const ROOT = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main/";
export const SOUND_URLS = Object.freeze({
  waterCalm: ROOT + "40-cc0-water-splash-slime-sfx/loop_water_01.ogg",
  waterWake: ROOT + "40-cc0-water-splash-slime-sfx/loop_water_02.ogg",
  rain: ROOT + "30-cc0-sfx-loops/rain.ogg",
  engine: ROOT + "30-cc0-sfx-loops/machine_01.ogg",
  pump: ROOT + "30-cc0-sfx-loops/pump_02.ogg",
  sonar: ROOT + "50-cc0-sci-fi-sfx/beep_02.ogg",
  sonarNear: ROOT + "50-cc0-sci-fi-sfx/beep_03.ogg",
  collision: ROOT + "100-CC0-wood-metal-SFX/metal_hit_03.ogg",
  splash: ROOT + "40-cc0-water-splash-slime-sfx/splash_11.ogg",
  rope: ROOT + "100-CC0-wood-metal-SFX/wood_hit_04.ogg",
  rescue: ROOT + "50-cc0-sci-fi-sfx/terminal_04.ogg",
  repair: ROOT + "100-cc0-sfx-2/sfx100v2_metal_04.ogg",
  win: ROOT + "50-cc0-sci-fi-sfx/terminal_09.ogg",
  deny: ROOT + "50-cc0-sci-fi-sfx/retro_beep_02.ogg",
  warning: ROOT + "30-cc0-sfx-loops/alarm_02.ogg",
});

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.buffers = new Map();
    this.loops = new Map();
    this.enabled = true;
    this.nextWakeAt = 0;
  }
  async init() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.compressor = this.ctx.createDynamicsCompressor();
    this.master.gain.value = 0.76;
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 16;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.22;
    this.master.connect(this.compressor).connect(this.ctx.destination);
    await this.ctx.resume();
    this.preload();
  }
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.enabled ? 0.76 : 0.0001, this.ctx.currentTime, 0.03);
  }
  async preload() {
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(SOUND_URLS).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
  }
  play(name, options = {}) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const filter = this.ctx.createBiquadFilter();
    source.buffer = buffer;
    source.playbackRate.value = options.rate || 1;
    source.loop = Boolean(options.loop);
    gain.gain.value = options.gain ?? 0.7;
    panner.pan.value = Math.max(-1, Math.min(1, options.pan || 0));
    filter.type = "lowpass";
    filter.frequency.value = options.lowpass || 18000;
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start();
    if (options.loop) this.loops.set(name, {source, gain, panner, filter});
    source.onended = () => { if (this.loops.get(name)?.source === source) this.loops.delete(name); };
    return source;
  }
  ensureLoop(name, options = {}) {
    if (!this.loops.has(name)) this.play(name, {...options, loop: true});
    const loop = this.loops.get(name);
    if (loop && this.ctx) {
      loop.gain.gain.setTargetAtTime(options.gain ?? 0.35, this.ctx.currentTime, 0.18);
      loop.panner.pan.setTargetAtTime(options.pan || 0, this.ctx.currentTime, 0.18);
      loop.filter.frequency.setTargetAtTime(options.lowpass || 18000, this.ctx.currentTime, 0.18);
      loop.source.playbackRate.setTargetAtTime(options.rate || 1, this.ctx.currentTime, 0.18);
    }
  }
  stopLoop(name) {
    const loop = this.loops.get(name);
    if (!loop) return;
    try { loop.source.stop(); } catch (_) {}
    this.loops.delete(name);
  }
  stopAll() {
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }
  update(view) {
    if (!this.ctx) return;
    const speed = Math.abs(view.boat.speed);
    this.ensureLoop("waterCalm", {gain: 0.13 + Math.min(0.08, speed / 150), rate: 0.82 + speed / 90, lowpass: 3800});
    this.ensureLoop("waterWake", {gain: Math.min(0.28, speed / 55), rate: 0.72 + speed / 36, lowpass: 6200});
    this.ensureLoop("rain", {gain: 0.035, rate: 0.96, lowpass: 7400});
    if (!view.boat.engineStalled && view.phase === "playing") {
      this.ensureLoop("engine", {gain: 0.07 + Math.abs(view.boat.throttle) * 0.25, rate: 0.64 + Math.abs(view.boat.throttle) * 0.68, lowpass: 1500 + Math.abs(view.boat.throttle) * 1700});
    } else this.stopLoop("engine");
    if (view.boat.pumpActive) this.ensureLoop("pump", {gain: 0.25, rate: 0.93, lowpass: 2400});
    else this.stopLoop("pump");

    if (speed > 3.5 && this.ctx.currentTime >= this.nextWakeAt) {
      this.play("splash", {gain: Math.min(0.42, 0.14 + speed / 65), pan: Math.random() * 1.4 - 0.7, rate: 0.84 + Math.random() * 0.28, lowpass: 6800});
      this.nextWakeAt = this.ctx.currentTime + Math.max(1.1, 3.1 - speed / 10) + Math.random() * 1.2;
    }
  }
  handle(events) {
    for (const event of events || []) {
      if (event.type === "sonar") {
        const name = event.distance < 28 ? "sonarNear" : "sonar";
        this.play(name, {pan: event.pan || 0, gain: 0.64, rate: Math.max(0.72, 1.45 - event.distance / 130)});
      } else if (event.type === "collision") {
        this.play("collision", {pan: event.pan || 0, gain: 0.88, lowpass: 5200});
        this.play("splash", {pan: event.pan || 0, gain: 0.72, rate: 0.9});
      } else if (event.type === "rope") this.play("rope", {gain: 0.62, lowpass: 5000});
      else if (event.type === "anchor") {
        this.play("rope", {gain: 0.48, rate: 0.8});
        this.play("splash", {gain: 0.45, rate: 0.78});
      } else if (event.type === "rescue-complete") this.play("rescue", {gain: 0.74});
      else if (event.type === "repair" || event.type === "repair-complete") this.play("repair", {gain: 0.58});
      else if (event.type === "win") this.play("win", {gain: 0.86});
      else if (event.type === "engine-stall" || event.type === "lose" || event.type === "warning") this.play("warning", {gain: event.critical ? 0.72 : 0.52, rate: event.critical ? 0.92 : 1.05});
      else if (event.type === "ui-deny") this.play("deny", {gain: 0.66, rate: 0.92});
    }
  }
}
