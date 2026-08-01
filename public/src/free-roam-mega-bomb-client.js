"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TEST_AMMO = 50;
const SPEED_OF_SOUND = 343;
const MAP_BOUNDS = Object.freeze({minX: 4, maxX: 416, minY: 4, maxY: 316});
const ASSET_URLS = Object.freeze({
  flight: new URL("../audio/mega-bomb-real-v2/flight.mp3", import.meta.url),
  explosion: new URL("../audio/mega-bomb-real-v2/explosion.mp3", import.meta.url),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (a, b) => Math.atan2((Number(b?.x) || 0) - (Number(a?.x) || 0), -((Number(b?.y) || 0) - (Number(a?.y) || 0))) * 180 / Math.PI;

function panFor(listener, point) {
  const relative = wrap(bearing(listener, point) - (Number(listener.heading) || 0));
  return clamp(Math.sin(relative * Math.PI / 180), -1, 1);
}

function shoreImages(source) {
  return [
    {surface: "west", x: MAP_BOUNDS.minX * 2 - source.x, y: source.y},
    {surface: "east", x: MAP_BOUNDS.maxX * 2 - source.x, y: source.y},
    {surface: "north", x: source.x, y: MAP_BOUNDS.minY * 2 - source.y},
    {surface: "south", x: source.x, y: MAP_BOUNDS.maxY * 2 - source.y},
  ];
}

export function outdoorReflectionPlan(event = {}, spatial = {}) {
  const source = {x: Number(event.x) || 0, y: Number(event.y) || 0};
  const listener = {
    x: Number(spatial.listenerX),
    y: Number(spatial.listenerY),
    heading: Number(spatial.listenerHeading) || 0,
  };
  const hasGeometry = Number.isFinite(listener.x) && Number.isFinite(listener.y);
  const directDistance = Math.max(0, Number(spatial.distance) || (hasGeometry ? distance(source, listener) : 0));
  const directPan = clamp(spatial.pan, -1, 1);
  const directGain = clamp(spatial.gain, 0, 1);
  const dry = {kind: "direct", delay: 0, pan: directPan, gain: directGain, lowpass: 15500, highpass: 28};

  const sourceHeight = Math.max(0.25, Number(event.z) || 0.35);
  const listenerHeight = 1.45;
  const horizontal = Math.max(0.01, directDistance);
  const direct3d = Math.hypot(horizontal, listenerHeight - sourceHeight);
  const waterPath = Math.hypot(horizontal, listenerHeight + sourceHeight);
  const water = {
    kind: "water",
    delay: clamp((waterPath - direct3d) / SPEED_OF_SOUND, 0.0005, 0.018),
    pan: directPan,
    gain: directGain * 0.17,
    lowpass: 7600,
    highpass: 70,
  };

  let shores;
  if (hasGeometry) {
    shores = shoreImages(source)
      .map(image => {
        const pathDistance = distance(listener, image);
        const extraDistance = Math.max(0, pathDistance - directDistance);
        return {
          surface: image.surface,
          delay: clamp(extraDistance / SPEED_OF_SOUND, 0.012, 0.82),
          pan: panFor(listener, image),
          pathDistance,
          extraDistance,
        };
      })
      .sort((a, b) => a.pathDistance - b.pathDistance)
      .slice(0, 2);
  } else {
    shores = [
      {surface: "near", delay: clamp(0.12 + directDistance / 2500, 0.12, 0.34), pan: clamp(-directPan * 0.5, -1, 1), extraDistance: 48},
      {surface: "far", delay: clamp(0.24 + directDistance / 1600, 0.24, 0.58), pan: clamp(directPan * 0.35, -1, 1), extraDistance: 92},
    ];
  }

  const shoreNear = {
    kind: "shore-near",
    surface: shores[0].surface,
    delay: shores[0].delay,
    pan: shores[0].pan,
    gain: directGain * 0.22 * clamp(1 / (1 + shores[0].extraDistance / 120), 0.25, 1),
    lowpass: 4800,
    highpass: 52,
  };
  const shoreFar = {
    kind: "shore-far",
    surface: shores[1].surface,
    delay: shores[1].delay,
    pan: shores[1].pan,
    gain: directGain * 0.13 * clamp(1 / (1 + shores[1].extraDistance / 150), 0.2, 1),
    lowpass: 3100,
    highpass: 48,
  };

  return {dry, water, shoreNear, shoreFar};
}

function spatialFor(event, playerIndex) {
  const value = event?.spatial?.[playerIndex] || {};
  return {
    pan: clamp(value.pan ?? event?.pan, -1, 1),
    gain: clamp(value.gain ?? 0.7, 0, 1),
    distance: Math.max(0, Number(value.distance) || 0),
    listenerX: Number(value.listenerX),
    listenerY: Number(value.listenerY),
    listenerHeading: Number(value.listenerHeading) || 0,
  };
}

class MegaBombAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.loadPromise = null;
    this.flights = new Map();
  }

  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -8;
      compressor.knee.value = 6;
      compressor.ratio.value = 7;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.32;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.92;
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    await this.loadAssets();
    return true;
  }

  async loadAssets() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = Promise.all(Object.entries(ASSET_URLS).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Mega-bomb audio ${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    })).catch(error => {
      console.warn("Не удалось загрузить реальные звуки мегабомбы", error);
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  playBuffer(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master) return null;
    const when = this.ctx.currentTime + Math.max(0, Number(options.delay) || 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = Boolean(options.loop);
    if (source.loop) {
      source.loopStart = Math.min(0.12, Math.max(0, buffer.duration - 0.15));
      source.loopEnd = Math.max(source.loopStart + 0.08, buffer.duration - 0.06);
    }
    source.playbackRate.value = clamp(options.playbackRate ?? 1, 0.55, 1.8);

    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = Math.max(10, Number(options.highpass) || 28);
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = Math.max(high.frequency.value + 10, Number(options.lowpass) || 15500);
    const gain = this.ctx.createGain();
    gain.gain.value = clamp(options.gain ?? 1, 0, 1.4);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(options.pan, -1, 1);

    source.connect(high).connect(low).connect(gain).connect(panner).connect(this.master);
    source.start(when);
    return {source, gain, panner, high, low};
  }

  async launch(event, playerIndex) {
    if (!await this.ensure()) return;
    this.startFlight(event, playerIndex);
  }

  startFlight(event, playerIndex) {
    if (!event?.projectileId || !this.ctx) return;
    this.stopFlight(event.projectileId);
    const spatial = spatialFor(event, playerIndex);
    const voice = this.playBuffer("flight", {
      loop: true,
      pan: spatial.pan,
      gain: 0.12 + spatial.gain * 0.46,
      highpass: 85,
      lowpass: 9800,
    });
    if (voice) this.flights.set(event.projectileId, voice);
  }

  async flight(event, playerIndex) {
    if (!event?.projectileId) return;
    if (!this.flights.has(event.projectileId)) {
      if (!await this.ensure()) return;
      this.startFlight(event, playerIndex);
    }
    const voice = this.flights.get(event.projectileId);
    if (!voice) return;
    const spatial = spatialFor(event, playerIndex);
    const now = this.ctx.currentTime;
    voice.panner.pan.setTargetAtTime(spatial.pan, now, 0.045);
    voice.gain.gain.setTargetAtTime(0.09 + spatial.gain * 0.5, now, 0.055);
  }

  stopFlight(id) {
    const voice = this.flights.get(id);
    if (!voice) return;
    try {
      const now = this.ctx?.currentTime || 0;
      voice.gain.gain.setTargetAtTime(0, now, 0.018);
      voice.source.stop(now + 0.065);
    } catch (_) {}
    this.flights.delete(id);
  }

  playExplosionLayer(layer) {
    this.playBuffer("explosion", layer);
  }

  async explode(event, playerIndex) {
    this.stopFlight(event?.projectileId);
    if (!await this.ensure()) return;
    const spatial = spatialFor(event, playerIndex);
    const plan = outdoorReflectionPlan(event, spatial);
    this.playExplosionLayer(plan.dry);
    this.playExplosionLayer(plan.water);
    this.playExplosionLayer(plan.shoreNear);
    this.playExplosionLayer(plan.shoreFar);
  }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio();
  let playerIndex = 0;
  let remaining = TEST_AMMO;
  let button = null;

  const report = text => {
    const message = document.getElementById("message");
    const live = document.getElementById("live");
    if (message) message.textContent = text;
    if (live) {
      live.textContent = "";
      requestAnimationFrame(() => { live.textContent = text; });
    }
  };
  const update = () => {
    if (!button) return;
    button.textContent = `Мега-бомба: ${remaining}`;
    button.setAttribute("aria-label", `Запустить мега-бомбу. Бесплатный тестовый запас: ${remaining}. Клавиша B.`);
    button.disabled = remaining <= 0;
  };
  const fire = async () => {
    await audio.ensure();
    if (globalThis.__freeRoamMegaBombBridge?.fire?.() !== true) report("Сначала подключись к свободному миру.");
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
    update();
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
    if (message.type === "lobby-ready") {
      playerIndex = message.role === "crew" ? 1 : 0;
      addButton();
      return;
    }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (Number.isFinite(Number(gameEvent.remaining))) {
        remaining = Math.max(0, Math.floor(Number(gameEvent.remaining)));
        update();
      }
      if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-denied") report(gameEvent.text || "Пуск недоступен.");
    }
  });
  new MutationObserver(addButton).observe(document.documentElement, {childList: true, subtree: true});
  addButton();
}

install();
