"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const FLIGHT_URL = new URL("../audio/mega-bomb-flight-real-v1.mp3?v=5", import.meta.url).href;
const EXPLOSION_URL = new URL("../audio/mega-bomb-explosion-v10.mp3?v=1", import.meta.url).href;
const TERMINAL_MS = 12000;
const TEST_AMMO = 25;
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));

class BombAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.loading = null;
    this.flights = new Map();
    this.pending = new Map();
    this.terminal = new Map();
  }
  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.86;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) this.loading = Promise.all([
      this.load("flight", FLIGHT_URL), this.load("explosion", EXPLOSION_URL),
    ]);
    await this.loading;
    return this.buffers.has("flight") && this.buffers.has("explosion");
  }
  async load(name, url) {
    try {
      const response = await fetch(url, {cache: "force-cache"});
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 1024) return;
      this.buffers.set(name, await this.ctx.decodeAudioData(bytes.slice(0)));
    } catch (_) {}
  }
  ended(id) {
    const key = String(id || "");
    if (!key) return;
    this.terminal.set(key, performance.now() + TERMINAL_MS);
    this.pending.delete(key);
    this.stop(key);
  }
  isEnded(id) {
    const key = String(id || "");
    const until = this.terminal.get(key) || 0;
    if (until > performance.now()) return true;
    if (until) this.terminal.delete(key);
    return false;
  }
  spatial(event, playerIndex) {
    const s = event?.spatial?.[playerIndex] || {};
    const speed = Math.max(0, Number(s.speed) || Number(event?.speed) || Math.hypot(event?.vx || 0, event?.vy || 0, event?.vz || 0));
    return {
      pan: clamp(s.pan ?? event?.pan, -1, 1),
      gain: clamp(s.gain ?? 0.7, 0, 1),
      rate: clamp(speed / 48, 0.52, 1.55),
      lowpass: clamp(16000 - (Number(s.distance) || 0) * 31, 2100, 16000),
    };
  }
  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(options.rate ?? 1, 0.48, 1.7);
    source.loop = Boolean(options.loop);
    if (source.loop) {
      source.loopStart = Math.min(0.08, buffer.duration * 0.12);
      source.loopEnd = Math.max(source.loopStart + 0.03, buffer.duration - 0.05);
    }
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = options.lowpass || 15000;
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const gain = this.ctx.createGain();
    gain.gain.value = clamp(options.gain ?? 1, 0, 1.2);
    source.connect(low);
    if (pan) { low.connect(pan).connect(gain); pan.pan.value = options.pan || 0; }
    else low.connect(gain);
    gain.connect(this.master);
    source.start();
    return {source, gain, low, pan, timer: null};
  }
  async begin(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isEnded(id)) return;
    const token = {};
    this.pending.set(id, token);
    if (!await this.ensure()) return;
    if (this.pending.get(id) !== token || this.isEnded(id)) return;
    this.pending.delete(id);
    this.stop(id);
    const s = this.spatial(event, playerIndex);
    const voice = this.play("flight", {loop: true, pan: s.pan, gain: s.gain, rate: s.rate, lowpass: s.lowpass});
    if (!voice) return;
    const remaining = clamp((Number(event?.maxAge) || 9) - (Number(event?.age) || 0) + 0.75, 0.35, 10.5);
    voice.timer = setTimeout(() => this.ended(id), remaining * 1000);
    voice.source.onended = () => {
      if (voice.timer) clearTimeout(voice.timer);
      if (this.flights.get(id)?.source === voice.source) this.flights.delete(id);
    };
    this.flights.set(id, voice);
  }
  async update(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isEnded(id)) return;
    if (!this.flights.has(id)) await this.begin(event, playerIndex);
    const voice = this.flights.get(id);
    if (!voice || this.isEnded(id)) return;
    const s = this.spatial(event, playerIndex);
    const now = this.ctx.currentTime;
    voice.gain.gain.setTargetAtTime(s.gain, now, 0.03);
    voice.low.frequency.setTargetAtTime(s.lowpass, now, 0.04);
    voice.source.playbackRate.setTargetAtTime(s.rate, now, 0.04);
    if (voice.pan) voice.pan.pan.setTargetAtTime(s.pan, now, 0.02);
  }
  stop(id) {
    const key = String(id || "");
    this.pending.delete(key);
    const voice = this.flights.get(key);
    if (!voice) return;
    if (voice.timer) clearTimeout(voice.timer);
    try {
      const now = this.ctx?.currentTime || 0;
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.01);
      voice.source.stop(now + 0.05);
      voice.source.disconnect();
      voice.gain.disconnect();
    } catch (_) {}
    this.flights.delete(key);
  }
  async explode(event, playerIndex) {
    const id = String(event?.projectileId || "");
    this.ended(id);
    if (!await this.ensure()) return;
    const s = this.spatial(event, playerIndex);
    this.play("explosion", {pan: s.pan, gain: Math.min(1.2, 0.2 + s.gain), rate: 1, lowpass: s.lowpass});
  }
  reset() {
    for (const id of [...this.flights.keys()]) this.stop(id);
    this.pending.clear();
    this.terminal.clear();
  }
}

function install() {
  if (globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new BombAudio();
  let playerIndex = 0;
  let remaining = TEST_AMMO;
  let button = null;
  const updateButton = () => {
    if (!button) return;
    button.textContent = `Мега-бомба: ${remaining}`;
    button.setAttribute("aria-label", `Запустить мега-бомбу. Зарядов: ${remaining}. Клавиша B.`);
    button.disabled = remaining <= 0;
  };
  const fire = async () => {
    await audio.ensure();
    globalThis.__freeRoamMegaBombBridge?.fire?.();
  };
  const addButton = () => {
    if (button?.isConnected) return;
    const controls = document.getElementById("controls");
    if (!controls) return;
    button = document.createElement("button");
    button.id = "megaBombButton";
    button.className = "danger";
    button.dataset.key = "B";
    button.setAttribute("aria-keyshortcuts", "B");
    button.addEventListener("click", event => { event.preventDefault(); fire(); });
    controls.append(button);
    updateButton();
  };
  document.addEventListener("pointerdown", () => audio.ensure().catch(() => {}), {capture: true, once: true});
  document.addEventListener("keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["b", "и"].includes(String(event.key).toLowerCase())) return;
    event.preventDefault();
    fire();
  }, true);
  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event.detail;
    if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready") { audio.reset(); playerIndex = message.role === "crew" ? 1 : 0; addButton(); return; }
    if (message.type === "network-closed") { audio.reset(); return; }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (Number.isFinite(Number(gameEvent.remaining)) && gameEvent?.targets?.includes(playerIndex)) {
        remaining = Math.max(0, Math.floor(Number(gameEvent.remaining)));
        updateButton();
      }
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (gameEvent.type === "mega-bomb-launch") audio.begin(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-flight") audio.update(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
    }
  });
  new MutationObserver(addButton).observe(document.documentElement, {childList: true, subtree: true});
  addButton();
}
install();
