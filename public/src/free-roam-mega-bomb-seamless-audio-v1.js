"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const URLS = Object.freeze({
  launch: new URL("../audio/mega-bomb-launch-v2.mp3?v=3", import.meta.url).href,
  flightSource: new URL("../audio/mega-bomb-flight-loop-v2.mp3?v=3", import.meta.url).href,
  near: new URL("../audio/mega-bomb-near-pass-v2.mp3?v=3", import.meta.url).href,
  explosion: new URL("../audio/mega-bomb-explosion-v11.mp3?v=3", import.meta.url).href,
  ricochet: new URL("../audio/mega-bomb-ricochet-hard-v1.mp3?v=3", import.meta.url).href,
  waterSkip: new URL("../audio/mega-bomb-water-skip-v1.mp3?v=3", import.meta.url).href,
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function spatial(event, playerIndex) {
  const value = event?.spatial?.[playerIndex] || {};
  const speed = Math.max(0, Number(value.speed) || Number(event?.speed) || Math.hypot(
    Number(event?.vx) || 0, Number(event?.vy) || 0, Number(event?.vz) || 0,
  ));
  return {
    pan: clamp(value.pan ?? event?.pan, -1, 1),
    gain: clamp(value.gain ?? 0.7, 0, 1),
    speed,
    distance: Math.max(0, Number(value.distance) || 0),
    radialSpeed: Number(value.radialSpeed) || 0,
    occluded: Boolean(value.occluded),
  };
}

class SeamlessMegaBombAudio {
  constructor() {
    this.ctx = null;
    this.output = null;
    this.buffers = new Map();
    this.loading = null;
    this.flights = new Map();
    this.terminal = new Map();
  }

  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 5;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.42;
      this.output = this.ctx.createGain();
      this.output.gain.value = 0.9;
      this.output.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) this.loading = this.loadAll();
    await this.loading;
    return this.buffers.has("flight");
  }

  async load(name, url) {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`${name}: invalid audio`);
    const decoded = await this.ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(name, decoded);
  }

  buildContinuousFlight(source) {
    const sampleRate = source.sampleRate;
    const input = source.getChannelData(0);
    const targetLength = Math.round(sampleRate * 11.2);
    const overlap = Math.min(Math.round(sampleRate * 0.28), Math.floor(input.length * 0.35));
    const stride = Math.max(1, input.length - overlap);
    const rendered = this.ctx.createBuffer(1, targetLength, sampleRate);
    const output = rendered.getChannelData(0);
    const weights = new Float32Array(targetLength);
    let position = 0;
    let segment = 0;
    while (position < targetLength) {
      const shift = Math.floor(((segment * 0.173) % 1) * input.length);
      const end = Math.min(targetLength, position + input.length);
      for (let index = position; index < end; index += 1) {
        const local = index - position;
        let envelope = 1;
        if (local < overlap) {
          envelope = Math.sin((local / Math.max(1, overlap - 1)) * Math.PI * 0.5) ** 2;
        } else if (local >= input.length - overlap) {
          const remaining = input.length - 1 - local;
          envelope = Math.sin((Math.max(0, remaining) / Math.max(1, overlap - 1)) * Math.PI * 0.5) ** 2;
        }
        output[index] += (input[(local + shift) % input.length] || 0) * envelope;
        weights[index] += envelope;
      }
      position += stride;
      segment += 1;
    }
    for (let index = 0; index < output.length; index += 1) {
      if (weights[index] > 0.0001) output[index] /= weights[index];
    }
    const attack = Math.min(output.length, Math.round(sampleRate * 0.03));
    for (let index = 0; index < attack; index += 1) {
      output[index] *= Math.sin((index / Math.max(1, attack - 1)) * Math.PI * 0.5) ** 2;
    }
    return rendered;
  }

  async loadAll() {
    await Promise.all(Object.entries(URLS).map(([name, url]) => this.load(name, url)
      .catch(error => console.warn(`Mega-bomb seamless audio: ${name}`, error))));
    const source = this.buffers.get("flightSource");
    if (source) this.buffers.set("flight", this.buildContinuousFlight(source));
  }

  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.output) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.playbackRate.value = clamp(options.rate ?? 1, 0.52, 1.52);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = clamp(options.lowpass ?? 16000, 500, 18000);
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = clamp(options.pan, -1, 1);
    source.connect(filter).connect(gain);
    if (panner) gain.connect(panner).connect(this.output);
    else gain.connect(this.output);
    const now = this.ctx.currentTime + Math.max(0, Number(options.delay) || 0);
    const level = clamp(options.gain ?? 1, 0, 1.4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(level, now + Math.max(0.004, Number(options.attack) || 0.02));
    const duration = Math.max(0, Number(options.duration) || 0);
    if (duration > 0) source.stop(now + duration);
    source.start(now);
    return {source, gain, filter, panner, timer: null, nearPlayed: false};
  }

  state(event, playerIndex) {
    const s = spatial(event, playerIndex);
    const speedRate = clamp(0.54 + s.speed / 64, 0.56, 1.38);
    const doppler = clamp(343 / Math.max(250, 343 + s.radialSpeed), 0.87, 1.16);
    return {
      ...s,
      rate: clamp(speedRate * doppler, 0.52, 1.52),
      gain: (0.018 + Math.pow(s.gain, 1.06) * 0.92)
        * Math.pow(clamp(s.speed / 48, 0.16, 1.22), 0.52) * (s.occluded ? 0.25 : 1),
      lowpass: s.occluded ? 760 : clamp(16200 - s.distance * 32, 2100, 16200),
      near: s.distance <= clamp(8 + s.speed * 0.22, 12, 25),
    };
  }

  rememberTerminal(id) {
    if (!id) return;
    this.terminal.set(String(id), performance.now() + 12000);
    this.stop(String(id));
  }

  isTerminal(id) {
    const until = this.terminal.get(String(id || "")) || 0;
    if (until > performance.now()) return true;
    if (until) this.terminal.delete(String(id || ""));
    return false;
  }

  async launch(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id) || !await this.ensure()) return;
    const s = this.state(event, playerIndex);
    this.play("launch", {pan: s.pan, gain: s.gain * 0.88, rate: clamp(s.rate, 0.72, 1.3), lowpass: s.lowpass, attack: 0.008});
    this.stop(id);
    const voice = this.play("flight", {pan: s.pan, gain: s.gain, rate: s.rate, lowpass: s.lowpass, attack: 0.03});
    if (!voice) return;
    voice.timer = setTimeout(() => this.rememberTerminal(id), 10500);
    voice.source.onended = () => {
      if (voice.timer) clearTimeout(voice.timer);
      if (this.flights.get(id)?.source === voice.source) this.flights.delete(id);
    };
    this.flights.set(id, voice);
  }

  async flight(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id)) return;
    if (!this.flights.has(id)) await this.launch(event, playerIndex);
    const voice = this.flights.get(id);
    if (!voice || !this.ctx) return;
    const s = this.state(event, playerIndex);
    const now = this.ctx.currentTime;
    voice.gain.gain.setTargetAtTime(s.gain, now, 0.034);
    voice.filter.frequency.setTargetAtTime(s.lowpass, now, 0.045);
    voice.source.playbackRate.setTargetAtTime(s.rate, now, 0.038);
    if (voice.panner) voice.panner.pan.setTargetAtTime(s.pan, now, 0.016);
    if (s.near && !voice.nearPlayed) {
      voice.nearPlayed = true;
      this.play("near", {pan: s.pan, gain: s.gain * 0.62, rate: s.rate, lowpass: s.lowpass, attack: 0.006, duration: 1.2});
    }
  }

  stop(id) {
    const key = String(id || "");
    const voice = this.flights.get(key);
    if (!voice) return;
    if (voice.timer) clearTimeout(voice.timer);
    try {
      const now = this.ctx?.currentTime || 0;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
      voice.gain.gain.linearRampToValueAtTime(0.0001, now + 0.045);
      voice.source.stop(now + 0.05);
    } catch (_) {}
    this.flights.delete(key);
  }

  async ricochet(event, playerIndex) {
    if (!await this.ensure()) return;
    const s = this.state(event, playerIndex);
    const water = event?.reason === "water-skip" || event?.surface === "water";
    this.play(water ? "waterSkip" : "ricochet", {
      pan: s.pan, gain: s.gain * (water ? 0.76 : 0.92), rate: s.rate * (water ? 0.82 : 0.9),
      lowpass: water ? 3100 : 9500, attack: 0.003,
    });
  }

  async explode(event, playerIndex) {
    const id = String(event?.projectileId || "");
    this.rememberTerminal(id);
    if (!await this.ensure()) return;
    const s = this.state(event, playerIndex);
    this.play("explosion", {pan: s.pan, gain: 0.16 + Math.pow(s.gain, 0.84), rate: 1, lowpass: s.occluded ? 900 : 16000, attack: 0.002});
  }

  reset() {
    for (const id of [...this.flights.keys()]) this.stop(id);
    this.terminal.clear();
  }
}

if (typeof document !== "undefined" && !globalThis.__megaBombSeamlessAudioInstalled) {
  globalThis.__megaBombSeamlessAudioInstalled = true;
  const audio = new SeamlessMegaBombAudio();
  let playerIndex = 0;
  document.addEventListener("pointerdown", () => audio.ensure().catch(() => {}), {capture: true, once: true});
  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event.detail;
    if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready") {
      audio.reset();
      playerIndex = message.role === "crew" ? 1 : 0;
      return;
    }
    if (message.type === "network-closed") {
      audio.reset();
      return;
    }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-ricochet") audio.ricochet(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
    }
  });
}
