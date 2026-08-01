"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TEST_AMMO = 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function outdoorReflectionPlan(spatial = {}) {
  const pan = clamp(spatial.pan, -1, 1);
  const distance = Math.max(0, Number(spatial.distance) || 0);
  const gain = clamp(spatial.gain, 0, 1);
  const side = pan >= 0 ? 1 : -1;
  return {
    dry: {delay: 0, pan, gain, lowpass: 15500, highpass: 28},
    water: {delay: clamp(0.072 + distance / 3200, 0.072, 0.145), pan: clamp(-pan * 0.34, -0.82, 0.82), gain: gain * 0.18, lowpass: 6900, highpass: 95},
    shore: {delay: clamp(0.15 + distance / 1800, 0.15, 0.31), pan: clamp(pan * 0.48 - side * 0.26, -0.9, 0.9), gain: gain * 0.115, lowpass: 2850, highpass: 62},
  };
}

function spatialFor(event, playerIndex) {
  const value = event?.spatial?.[playerIndex] || {};
  return {pan: clamp(value.pan ?? event?.pan, -1, 1), gain: clamp(value.gain ?? 0.7, 0, 1), distance: Math.max(0, Number(value.distance) || 0)};
}

class MegaBombAudio {
  constructor() { this.ctx = null; this.master = null; this.flights = new Map(); }

  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -10; compressor.knee.value = 8; compressor.ratio.value = 8;
      compressor.attack.value = 0.002; compressor.release.value = 0.28;
      this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    return true;
  }

  noise(seconds) {
    const buffer = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * seconds)), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    return buffer;
  }

  playExplosionLayer(options) {
    const when = this.ctx.currentTime + options.delay;
    const panner = this.ctx.createStereoPanner(); panner.pan.value = options.pan;
    const bus = this.ctx.createGain(); bus.gain.value = options.gain;
    const high = this.ctx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = options.highpass;
    const low = this.ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.setValueAtTime(options.lowpass, when); low.frequency.exponentialRampToValueAtTime(680, when + 2.5);
    const body = this.ctx.createBufferSource(); body.buffer = this.noise(2.7);
    const envelope = this.ctx.createGain(); envelope.gain.setValueAtTime(0.0001, when); envelope.gain.exponentialRampToValueAtTime(0.92, when + 0.006); envelope.gain.exponentialRampToValueAtTime(0.0001, when + 2.65);
    body.connect(high).connect(low).connect(envelope).connect(bus).connect(panner).connect(this.master); body.start(when);

    const sub = this.ctx.createOscillator(); sub.type = "sine"; sub.frequency.setValueAtTime(62, when); sub.frequency.exponentialRampToValueAtTime(27, when + 0.75);
    const subGain = this.ctx.createGain(); subGain.gain.setValueAtTime(0.0001, when); subGain.gain.exponentialRampToValueAtTime(0.62, when + 0.012); subGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.84);
    sub.connect(subGain).connect(bus); sub.start(when); sub.stop(when + 0.88);

    for (let index = 0; index < 7; index += 1) {
      const fragment = this.ctx.createBufferSource(); fragment.buffer = this.noise(0.055);
      const filter = this.ctx.createBiquadFilter(); filter.type = "bandpass"; filter.frequency.value = 1450 + Math.random() * 5200; filter.Q.value = 1.2 + Math.random() * 2;
      const gain = this.ctx.createGain(); const at = when + 0.08 + index * 0.045 + Math.random() * 0.065;
      gain.gain.setValueAtTime(0.14 + Math.random() * 0.16, at); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      fragment.connect(filter).connect(gain).connect(bus); fragment.start(at);
    }
  }

  async launch(event, playerIndex) {
    if (!await this.ensure()) return;
    const spatial = spatialFor(event, playerIndex), now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner(); pan.pan.value = spatial.pan;
    const gain = this.ctx.createGain(); gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.12 + spatial.gain * 0.2, now + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    const low = this.ctx.createOscillator(); low.type = "sawtooth"; low.frequency.setValueAtTime(118, now); low.frequency.exponentialRampToValueAtTime(54, now + 0.45);
    const whistle = this.ctx.createOscillator(); whistle.frequency.setValueAtTime(620, now); whistle.frequency.exponentialRampToValueAtTime(1180, now + 0.34);
    low.connect(gain); whistle.connect(gain); gain.connect(pan).connect(this.master); low.start(now); whistle.start(now); low.stop(now + 0.55); whistle.stop(now + 0.42);
    this.startFlight(event, playerIndex);
  }

  startFlight(event, playerIndex) {
    if (!event?.projectileId || !this.ctx) return;
    this.stopFlight(event.projectileId);
    const spatial = spatialFor(event, playerIndex);
    const tone = this.ctx.createOscillator(); tone.type = "sawtooth"; tone.frequency.value = 172;
    const air = this.ctx.createBufferSource(); air.buffer = this.noise(0.55); air.loop = true;
    const filter = this.ctx.createBiquadFilter(); filter.type = "bandpass"; filter.frequency.value = 1400; filter.Q.value = 0.7;
    const pan = this.ctx.createStereoPanner(); pan.pan.value = spatial.pan;
    const gain = this.ctx.createGain(); gain.gain.value = 0.018 + spatial.gain * 0.09;
    tone.connect(gain); air.connect(filter).connect(gain); gain.connect(pan).connect(this.master); tone.start(); air.start();
    this.flights.set(event.projectileId, {tone, air, filter, pan, gain});
  }

  async flight(event, playerIndex) {
    if (!event?.projectileId) return;
    if (!this.flights.has(event.projectileId)) { if (!await this.ensure()) return; this.startFlight(event, playerIndex); }
    const loop = this.flights.get(event.projectileId); if (!loop) return;
    const spatial = spatialFor(event, playerIndex), progress = clamp(event.progress, 0, 1), now = this.ctx.currentTime;
    loop.pan.pan.setTargetAtTime(spatial.pan, now, 0.045); loop.gain.gain.setTargetAtTime(0.014 + spatial.gain * 0.11, now, 0.05);
    loop.tone.frequency.setTargetAtTime(160 + progress * 96, now, 0.055); loop.filter.frequency.setTargetAtTime(1250 + progress * 1050, now, 0.06);
  }

  stopFlight(id) {
    const loop = this.flights.get(id); if (!loop) return;
    try { const now = this.ctx?.currentTime || 0; loop.gain.gain.setTargetAtTime(0, now, 0.02); loop.tone.stop(now + 0.07); loop.air.stop(now + 0.07); } catch (_) {}
    this.flights.delete(id);
  }

  async explode(event, playerIndex) {
    this.stopFlight(event?.projectileId); if (!await this.ensure()) return;
    const plan = outdoorReflectionPlan(spatialFor(event, playerIndex));
    this.playExplosionLayer(plan.dry); this.playExplosionLayer(plan.water); this.playExplosionLayer(plan.shore);
  }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio(); let playerIndex = 0, remaining = TEST_AMMO, button = null;
  const report = text => { const message = document.getElementById("message"), live = document.getElementById("live"); if (message) message.textContent = text; if (live) { live.textContent = ""; requestAnimationFrame(() => { live.textContent = text; }); } };
  const update = () => { if (!button) return; button.textContent = `Мега-бомба: ${remaining}`; button.setAttribute("aria-label", `Запустить мега-бомбу. Бесплатный тестовый запас: ${remaining}. Клавиша B.`); button.disabled = remaining <= 0; };
  const fire = async () => { await audio.ensure(); if (globalThis.__freeRoamMegaBombBridge?.fire?.() !== true) report("Сначала подключись к свободному миру."); };
  const addButton = () => { if (button?.isConnected) return; const controls = document.getElementById("controls"); if (!controls) return; button = document.createElement("button"); button.id = "megaBombButton"; button.className = "danger"; button.dataset.key = "B"; button.setAttribute("aria-keyshortcuts", "B"); button.addEventListener("click", event => { event.preventDefault(); fire(); }); controls.append(button); update(); };
  document.addEventListener("pointerdown", () => audio.ensure().catch(() => {}), {capture: true, once: true});
  document.addEventListener("keydown", event => { if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return; if (!["b", "и"].includes(String(event.key).toLowerCase())) return; event.preventDefault(); fire(); }, true);
  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event.detail; if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready") { playerIndex = message.role === "crew" ? 1 : 0; addButton(); return; }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (Number.isFinite(Number(gameEvent.remaining))) { remaining = Math.max(0, Math.floor(Number(gameEvent.remaining))); update(); }
      if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-denied") report(gameEvent.text || "Пуск недоступен.");
    }
  });
  new MutationObserver(addButton).observe(document.documentElement, {childList: true, subtree: true}); addButton();
}

install();
