"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TERMINAL_MS = 12000;
const URLS = Object.freeze({
  launch: new URL("../audio/mega-bomb-launch-v2.mp3?v=6", import.meta.url).href,
  flightSource: new URL("../audio/mega-bomb-flight-loop-v2.mp3?v=6", import.meta.url).href,
  near: new URL("../audio/mega-bomb-near-pass-v2.mp3?v=6", import.meta.url).href,
  explosionPreferred: new URL("../audio/mega-bomb-explosion-v12.mp3?v=12", import.meta.url).href,
  explosionFallback: new URL("../audio/mega-bomb-explosion-v11.mp3?v=7", import.meta.url).href,
  ricochet: new URL("../audio/mega-bomb-ricochet-hard-v1.mp3?v=6", import.meta.url).href,
  waterSkip: new URL("../audio/mega-bomb-water-skip-v1.mp3?v=6", import.meta.url).href,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const panGains = value => {
  const pan = Math.sign(clamp(value, -1, 1)) * Math.pow(Math.abs(clamp(value, -1, 1)), 0.66);
  const angle = (pan + 1) * Math.PI / 4;
  return {left: Math.cos(angle), right: Math.sin(angle)};
};

function spatial(event, playerIndex) {
  const value = event?.spatial?.[playerIndex] || {};
  const speed = Math.max(0, Number(value.speed) || Number(event?.speed) || Math.hypot(
    Number(event?.vx) || 0, Number(event?.vy) || 0, Number(event?.vz) || 0,
  ));
  const distance = Math.max(0, Number(value.distance) || 0);
  const radial = Number(value.radialSpeed) || 0;
  const doppler = clamp(343 / Math.max(250, 343 + radial), 0.87, 1.16);
  return {
    pan: clamp(value.pan ?? event?.pan, -1, 1),
    gain: (0.018 + Math.pow(clamp(value.gain ?? 0.7, 0, 1), 1.06) * 0.92)
      * Math.pow(clamp(speed / 48, 0.16, 1.22), 0.52) * (value.occluded ? 0.25 : 1),
    speed,
    distance,
    rate: clamp((0.54 + speed / 64) * doppler, 0.52, 1.52),
    lowpass: value.occluded ? 760 : clamp(16200 - distance * 32, 2100, 16200),
    highpass: clamp(48 + speed * 1.15, 52, 135),
    near: distance <= clamp(8 + speed * 0.22, 12, 25),
    occluded: Boolean(value.occluded),
  };
}

class MegaBombAudio {
  constructor() {
    this.ctx = null;
    this.output = null;
    this.buffers = new Map();
    this.loading = null;
    this.voices = new Map();
    this.terminal = new Map();
  }

  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -5;
      compressor.knee.value = 5;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.58;
      this.output = this.ctx.createGain();
      this.output.gain.value = 0.9;
      this.output.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) this.loading = this.loadAll();
    await this.loading;
    return this.buffers.has("flight") && this.buffers.has("explosion");
  }

  async load(name, url) {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`${name}: invalid audio`);
    const decoded = await this.ctx.decodeAudioData(bytes.slice(0));
    if (decoded.numberOfChannels <= 1) this.buffers.set(name, decoded);
    else {
      const mono = this.ctx.createBuffer(1, decoded.length, decoded.sampleRate);
      const out = mono.getChannelData(0);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const input = decoded.getChannelData(channel);
        for (let index = 0; index < out.length; index += 1) out[index] += input[index] / decoded.numberOfChannels;
      }
      this.buffers.set(name, mono);
    }
  }

  buildFlight(source) {
    const sampleRate = source.sampleRate;
    const input = source.getChannelData(0);
    const result = this.ctx.createBuffer(1, Math.round(sampleRate * 18), sampleRate);
    const output = result.getChannelData(0);
    const weights = new Float32Array(output.length);
    const lengths = [1.28,1.07,1.41,0.94,1.22,1.53,1.01,1.36,1.16,1.47,0.98,1.31,1.11,1.44,1.03,1.38];
    const rates = [0.91,1.06,0.84,1.15,0.97,1.10,0.88,1.04,0.94,1.18,0.86,1.08,0.99,1.13,0.89,1.02];
    let position = 0;
    for (let grain = 0; position < output.length; grain += 1) {
      const duration = Math.round(sampleRate * lengths[grain % lengths.length]);
      const overlap = Math.min(Math.round(sampleRate * (0.24 + (grain % 4) * 0.025)), Math.floor(duration * 0.42));
      const rate = rates[grain % rates.length];
      const phase = Math.floor((((grain * 0.271) + (grain % 3) * 0.113) % 1) * input.length);
      for (let local = 0; local < duration && position + local < output.length; local += 1) {
        const sourcePosition = phase + local * rate;
        const base = Math.floor(sourcePosition) % input.length;
        const fraction = sourcePosition - Math.floor(sourcePosition);
        const sample = input[base] * (1 - fraction) + input[(base + 1) % input.length] * fraction;
        let envelope = 1;
        if (local < overlap) envelope = Math.sin((local / Math.max(1, overlap - 1)) * Math.PI * 0.5) ** 2;
        else if (local >= duration - overlap) envelope = Math.cos(((local - duration + overlap) / Math.max(1, overlap - 1)) * Math.PI * 0.5) ** 2;
        const index = position + local;
        const movement = 0.91 + 0.055 * Math.sin(index / sampleRate * (1.7 + grain * 0.013));
        output[index] += sample * envelope * movement;
        weights[index] += envelope;
      }
      position += Math.max(1, duration - overlap);
    }
    for (let index = 0; index < output.length; index += 1) if (weights[index] > 0.0001) output[index] /= weights[index];
    const attack = Math.round(sampleRate * 0.025);
    for (let index = 0; index < attack; index += 1) output[index] *= Math.sin((index / Math.max(1, attack - 1)) * Math.PI * 0.5) ** 2;
    return result;
  }

  async loadAll() {
    const common = [["launch",URLS.launch],["flightSource",URLS.flightSource],["near",URLS.near],["ricochet",URLS.ricochet],["waterSkip",URLS.waterSkip]];
    await Promise.all(common.map(([name,url]) => this.load(name,url).catch(error => console.warn(`Mega-bomb ${name}`, error))));
    const source = this.buffers.get("flightSource");
    if (source) this.buffers.set("flight", this.buildFlight(source));
    try { await this.load("explosion", URLS.explosionPreferred); }
    catch (error) {
      console.warn("Preferred mega-bomb explosion unavailable", error);
      await this.load("explosion", URLS.explosionFallback).catch(fallback => console.warn("Fallback explosion unavailable", fallback));
    }
  }

  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.output) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.playbackRate.value = clamp(options.rate ?? 1, 0.48, 1.7);
    const low = this.ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = Math.max(180, options.lowpass || 15500);
    const high = this.ctx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = Math.max(20, options.highpass || 24);
    const volume = this.ctx.createGain();
    const left = this.ctx.createGain(); const right = this.ctx.createGain(); const merger = this.ctx.createChannelMerger(2);
    source.connect(high).connect(low).connect(volume); volume.connect(left); volume.connect(right);
    left.connect(merger,0,0); right.connect(merger,0,1); merger.connect(this.output);
    const setPan = (value, when = this.ctx.currentTime, smoothing = 0) => {
      const gains = panGains(value);
      if (smoothing) { left.gain.setTargetAtTime(gains.left, when, smoothing); right.gain.setTargetAtTime(gains.right, when, smoothing); }
      else { left.gain.setValueAtTime(gains.left, when); right.gain.setValueAtTime(gains.right, when); }
    };
    const now = this.ctx.currentTime + Math.max(0, Number(options.delay) || 0);
    const gain = clamp(options.gain ?? 1, 0, 1.45);
    setPan(options.pan, now); volume.gain.setValueAtTime(0.0001, now); volume.gain.linearRampToValueAtTime(gain, now + (options.attack || 0.006));
    source.start(now, Math.max(0, Number(options.offset) || 0));
    return {source, volume, low, high, setPan, nearPlayed: false, timer: null};
  }

  isTerminal(id) {
    const until = this.terminal.get(id) || 0;
    if (until > performance.now()) return true;
    if (until) this.terminal.delete(id);
    return false;
  }

  stop(id, remember = false) {
    const key = String(id || "");
    if (remember) this.terminal.set(key, performance.now() + TERMINAL_MS);
    const voice = this.voices.get(key);
    if (!voice) return;
    if (voice.timer) clearTimeout(voice.timer);
    try {
      const now = this.ctx.currentTime;
      voice.volume.gain.setTargetAtTime(0.0001, now, 0.012);
      voice.source.stop(now + 0.055);
    } catch (_) {}
    this.voices.delete(key);
  }

  async launch(event, playerIndex, withLaunch = true) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id) || !await this.ensure()) return;
    const state = spatial(event, playerIndex);
    if (withLaunch) this.play("launch", {pan: state.pan, gain: state.gain * 0.88, rate: clamp(state.rate,0.72,1.3), lowpass: state.lowpass});
    this.stop(id);
    const voice = this.play("flight", {pan: state.pan, gain: state.gain, rate: state.rate, lowpass: state.lowpass, highpass: state.highpass, attack: 0.018});
    if (!voice) return;
    const remaining = clamp((Number(event.maxAge)||0) - (Number(event.age)||0) + 0.75, 0.35, 10.5);
    voice.timer = setTimeout(() => this.stop(id, true), remaining * 1000);
    voice.source.onended = () => { if (this.voices.get(id)?.source === voice.source) this.voices.delete(id); };
    this.voices.set(id, voice);
  }

  async flight(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id)) return;
    if (!this.voices.has(id)) await this.launch(event, playerIndex, false);
    const voice = this.voices.get(id); if (!voice) return;
    const state = spatial(event, playerIndex); const now = this.ctx.currentTime;
    voice.setPan(state.pan, now, 0.016);
    voice.volume.gain.setTargetAtTime(state.gain, now, 0.034);
    voice.low.frequency.setTargetAtTime(state.lowpass, now, 0.045);
    voice.high.frequency.setTargetAtTime(state.highpass, now, 0.045);
    voice.source.playbackRate.setTargetAtTime(state.rate, now, 0.038);
    if (state.near && !voice.nearPlayed) { voice.nearPlayed = true; this.play("near", {pan:state.pan,gain:state.gain*0.62,rate:state.rate,lowpass:state.lowpass}); }
  }

  async explode(event, playerIndex) {
    const id = String(event?.projectileId || ""); this.stop(id, true);
    if (!await this.ensure()) return;
    const state = spatial(event, playerIndex);
    this.play("explosion", {pan:state.pan,gain:0.16+Math.pow(clamp(event?.spatial?.[playerIndex]?.gain??0.7,0,1),0.84),lowpass:state.occluded?900:16000,rate:1});
    this.play("explosion", {delay:0.19,pan:-state.pan*0.35,gain:state.gain*0.13,lowpass:3400,rate:0.94,offset:0.18});
  }

  async ricochet(event, playerIndex) {
    if (!await this.ensure()) return;
    const state = spatial(event, playerIndex); const water = event?.reason === "water-skip" || event?.surface === "water";
    this.play(water?"waterSkip":"ricochet", {pan:state.pan,gain:state.gain*(water?0.76:0.92),rate:state.rate*(water?0.82:0.9),lowpass:water?3100:9500});
  }

  reset() { for (const id of [...this.voices.keys()]) this.stop(id); this.terminal.clear(); }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio();
  let playerIndex = 0; let remaining = 25; let button = null;
  const report = text => {
    const message = document.getElementById("message"); const live = document.getElementById("live");
    if (message) message.textContent = text;
    if (live) { live.textContent = ""; requestAnimationFrame(() => { live.textContent = text; }); }
  };
  const update = () => {
    if (!button) return;
    button.textContent = `Мега-бомба: ${remaining}`;
    button.setAttribute("aria-label", `Запустить мега-бомбу. Зарядов: ${remaining}. Клавиша B.`);
    button.disabled = remaining <= 0;
  };
  const fire = async () => {
    await audio.ensure();
    if (globalThis.__freeRoamMegaBombBridge?.fire?.() !== true) report("Сначала подключись к свободному миру.");
  };
  const addButton = () => {
    if (button?.isConnected) return;
    const controls = document.getElementById("controls"); if (!controls) return;
    button = document.createElement("button"); button.id = "megaBombButton"; button.className = "danger";
    button.dataset.key = "B"; button.setAttribute("aria-keyshortcuts", "B");
    button.addEventListener("click", event => { event.preventDefault(); fire(); }); controls.append(button); update();
  };
  document.addEventListener("pointerdown", () => audio.ensure().catch(() => {}), {capture:true,once:true});
  document.addEventListener("keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["b","и"].includes(String(event.key).toLowerCase())) return;
    event.preventDefault(); fire();
  }, true);
  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event.detail; if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready") { audio.reset(); playerIndex = message.role === "crew" ? 1 : 0; addButton(); return; }
    if (message.type === "network-closed") { audio.reset(); return; }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (Number.isFinite(Number(gameEvent.remaining)) && gameEvent?.targets?.includes(playerIndex)) { remaining = Math.max(0,Math.floor(Number(gameEvent.remaining))); update(); }
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex, true);
      else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-ricochet") audio.ricochet(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-denied") report(gameEvent.text || "Пуск недоступен.");
    }
  });
  new MutationObserver(addButton).observe(document.documentElement,{childList:true,subtree:true}); addButton();
}

install();
