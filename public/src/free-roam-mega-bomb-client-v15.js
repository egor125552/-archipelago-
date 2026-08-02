"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TEST_AMMO = 25;
const SPEED_OF_SOUND = 343;
const LAND_RECT = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
const FLIGHT_URL = new URL("../audio/mega-bomb-flight-real-v1.mp3?v=5", import.meta.url).href;
const EXPLOSION_URL = new URL("../audio/mega-bomb-explosion-v10.mp3?v=1", import.meta.url).href;
const KILL_URL = new URL("../audio/enemy-killed-v5.mp3?v=1", import.meta.url).href;

export const KILL_EVENT_TYPES = Object.freeze(new Set([
  "enemy-boat-destroyed", "pursuer-destroyed", "gunner-destroyed",
  "hostile-actor-destroyed", "elite-destroyed", "heavy-turret-destroyed",
  "heavy-pursuer-destroyed",
]));

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function pointInsideRect(point, rect = LAND_RECT) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

function segmentIntersectsRect(a, b, rect = LAND_RECT) {
  const x0 = Number(a?.x), y0 = Number(a?.y), x1 = Number(b?.x), y1 = Number(b?.y);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  let near = 0, far = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rect.minX, rect.maxX - x0, y0 - rect.minY, rect.maxY - y0];
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(p[index]) < 1e-9) {
      if (q[index] < 0) return false;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) near = Math.max(near, ratio);
    else far = Math.min(far, ratio);
    if (near > far) return false;
  }
  return true;
}

export function pathOccludedByLand(source, listener) {
  return !pointInsideRect(source) && !pointInsideRect(listener)
    && segmentIntersectsRect(source, listener);
}

function spatialFor(event, playerIndex) {
  const value = event?.spatial?.[playerIndex] || {};
  return {
    pan: clamp(value.pan ?? event?.pan, -1, 1),
    gain: clamp(value.gain ?? 0.7, 0, 1),
    distance: Math.max(0, Number(value.distance) || 0),
    radialSpeed: Number(value.radialSpeed) || 0,
    speed: Math.max(0, Number(value.speed) || Number(event?.speed) || Math.hypot(
      Number(event?.vx) || 0,
      Number(event?.vy) || 0,
      Number(event?.vz) || 0,
    )),
    elevation: Number(value.elevation) || 0,
    occluded: Boolean(value.occluded),
    listenerX: Number(value.listenerX),
    listenerY: Number(value.listenerY),
    listenerHeading: Number(value.listenerHeading) || 0,
    surface: value.surface || event?.surface || "water",
  };
}

function lowpassFor(spatial) {
  if (spatial.occluded) return 820;
  const distanceCut = 16000 - spatial.distance * 31;
  const elevationLift = clamp(Math.abs(spatial.elevation) / 60, 0, 1) * 900;
  return clamp(distanceCut + elevationLift, 2300, 16000);
}

export function flightAudioState(event = {}, spatial = {}) {
  const resolved = {
    pan: clamp(spatial.pan ?? event.pan, -1, 1),
    gain: clamp(spatial.gain ?? 0.7, 0, 1),
    distance: Math.max(0, Number(spatial.distance) || 0),
    radialSpeed: Number(spatial.radialSpeed) || 0,
    speed: Math.max(0, Number(spatial.speed) || Number(event.speed) || Math.hypot(
      Number(event.vx) || 0,
      Number(event.vy) || 0,
      Number(event.vz) || 0,
    )),
    elevation: Number(spatial.elevation) || 0,
    occluded: Boolean(spatial.occluded),
  };
  const speedRate = clamp(resolved.speed / 48, 0.52, 1.55);
  const doppler = clamp(
    SPEED_OF_SOUND / Math.max(245, SPEED_OF_SOUND + resolved.radialSpeed),
    0.84,
    1.2,
  );
  const motionGain = Math.pow(clamp(resolved.speed / 48, 0.22, 1.25), 0.45);
  return {
    pan: resolved.pan,
    gain: (0.028 + Math.pow(resolved.gain, 1.08) * 0.9) * motionGain * (resolved.occluded ? 0.28 : 1),
    lowpass: lowpassFor(resolved),
    playbackRate: clamp(speedRate * doppler, 0.5, 1.65),
  };
}

export function outdoorReflectionPlan(event = {}, spatial = {}) {
  const source = {x: Number(event.x) || 0, y: Number(event.y) || 0};
  const listener = {x: Number(spatial.listenerX), y: Number(spatial.listenerY)};
  const hasGeometry = Number.isFinite(listener.x) && Number.isFinite(listener.y);
  const distance = Math.max(0, Number(spatial.distance) || 0);
  const pan = clamp(spatial.pan, -1, 1);
  const gain = clamp(spatial.gain, 0, 1);
  const surface = event.surface || spatial.surface || "water";
  const reason = String(event.reason || "");
  const occluded = Boolean(spatial.occluded)
    || (hasGeometry && pathOccludedByLand(source, listener));
  const propagation = clamp(distance / SPEED_OF_SOUND, 0, 1.35);
  const surfaceMuffle = surface === "water" ? 0.76 : surface === "shore" ? 0.9 : 1;
  const directGain = (0.14 + Math.pow(gain, 0.86) * 1.05) * surfaceMuffle;
  const collisionSharpness = /ricochet|terrain|boundary/.test(reason) ? 1.12 : 1;
  const dry = {
    delay: propagation,
    pan,
    gain: directGain * (occluded ? 0.055 : 1),
    lowpass: occluded ? 760 : surface === "water" ? 7600 : 15800,
    highpass: surface === "water" ? 20 : 28,
    offset: 0,
    attack: 0.002,
    fadeOut: 0.3,
    playbackRate: clamp(collisionSharpness, 0.8, 1.2),
    occluded,
  };
  const reflectionBase = directGain * (occluded ? 0.16 : 0.11);
  const water = {
    delay: propagation + clamp(0.075 + distance / 3600, 0.075, 0.19),
    pan: clamp(-pan * 0.35, -0.85, 0.85),
    gain: reflectionBase * (surface === "water" ? 1.25 : 0.85),
    lowpass: surface === "water" ? 3900 : 6100,
    highpass: 55,
    offset: 0.14,
    attack: 0.004,
    fadeOut: 0.36,
    playbackRate: 0.94,
    maxDuration: 2.8,
  };
  const shoreNear = {
    delay: propagation + clamp(0.13 + distance / 2300, 0.13, 0.36),
    pan: clamp(pan * 0.42 - Math.sign(pan || 1) * 0.28, -0.92, 0.92),
    gain: reflectionBase * (surface === "ground" || surface === "shore" ? 1.15 : 0.78),
    lowpass: 3300,
    highpass: 48,
    offset: 0.18,
    attack: 0.006,
    fadeOut: 0.42,
    playbackRate: 0.9,
    maxDuration: 3.2,
  };
  const shoreFar = {
    delay: propagation + clamp(0.3 + distance / 1750, 0.3, 0.68),
    pan: clamp(-pan * 0.22, -0.75, 0.75),
    gain: shoreNear.gain * 0.56,
    lowpass: 2100,
    highpass: 42,
    offset: 0.24,
    attack: 0.008,
    fadeOut: 0.48,
    playbackRate: 0.84,
    maxDuration: 3.5,
  };
  const diffraction = {
    delay: propagation + 0.065,
    pan,
    gain: occluded ? directGain * 0.23 : 0,
    lowpass: 1250,
    highpass: 62,
    offset: 0.12,
    attack: 0.008,
    fadeOut: 0.4,
    playbackRate: 0.88,
    maxDuration: 3,
  };
  return {dry, water, shoreNear, shoreFar, diffraction};
}

function eventIdentity(event) {
  return [
    event?.type,
    Number(event?.at) || 0,
    event?.actorId || event?.gunnerId || event?.pursuerId
      || event?.sourcePursuerId || event?.projectileId || "",
  ].join(":");
}

function stereoGains(value) {
  const pan = Math.sign(clamp(value, -1, 1)) * Math.pow(Math.abs(clamp(value, -1, 1)), 0.66);
  const angle = (pan + 1) * Math.PI / 4;
  return {left: Math.cos(angle), right: Math.sin(angle)};
}

class MegaBombAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.loading = null;
    this.flights = new Map();
  }

  async ensure() {
    if (!this.ctx) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass({latencyHint: "interactive"});
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -5;
      compressor.knee.value = 4;
      compressor.ratio.value = 5.5;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.5;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) this.loading = this.loadBuffers();
    await this.loading;
    return this.buffers.has("flight") && this.buffers.has("explosion");
  }

  toMono(buffer) {
    if (!buffer || buffer.numberOfChannels <= 1) return buffer;
    const mono = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const output = mono.getChannelData(0);
    const channels = Array.from(
      {length: buffer.numberOfChannels},
      (_, channel) => buffer.getChannelData(channel),
    );
    for (let index = 0; index < output.length; index += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[index] || 0;
      output[index] = sum / channels.length;
    }
    return mono;
  }

  async loadUrl(name, url) {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("audio") && !contentType.includes("octet-stream")) {
      throw new Error(`${name}: вместо аудио получен ${contentType}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`${name}: файл слишком короткий`);
    const decoded = await this.ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(name, this.toMono(decoded));
  }

  async loadBuffers() {
    await Promise.all([
      this.loadUrl("flight", FLIGHT_URL)
        .catch(error => console.warn("Не удалось загрузить полёт мега-бомбы", error)),
      this.loadUrl("explosion", EXPLOSION_URL)
        .catch(error => console.warn("Не удалось загрузить взрыв мега-бомбы", error)),
      this.loadUrl("kill", KILL_URL)
        .catch(error => console.warn("Не удалось загрузить подтверждение уничтожения", error)),
    ]);
  }

  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master) return null;
    const targetGain = clamp(options.gain ?? 1, 0, 1.4);
    if (targetGain <= 0) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(options.playbackRate ?? 1, 0.48, 1.7);
    if (options.loop && buffer.duration > 0.08) {
      const maximumStart = Math.max(0, buffer.duration - 0.04);
      const loopStart = clamp(options.loopStart ?? 0.04, 0, maximumStart);
      const requestedEnd = Number(options.loopEnd)
        || Math.max(loopStart + 0.04, buffer.duration - 0.025);
      const loopEnd = Math.min(buffer.duration, Math.max(loopStart + 0.015, requestedEnd));
      if (loopEnd > loopStart + 0.01) {
        source.loop = true;
        source.loopStart = loopStart;
        source.loopEnd = loopEnd;
      }
    }
    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = Math.max(20, Number(options.highpass) || 24);
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = Math.max(180, Number(options.lowpass) || 15500);
    const volume = this.ctx.createGain();
    const left = this.ctx.createGain();
    const right = this.ctx.createGain();
    const merger = this.ctx.createChannelMerger(2);
    source.connect(high).connect(low).connect(volume);
    volume.connect(left);
    volume.connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(this.master);
    const setPan = (value, when = this.ctx.currentTime, smoothing = 0) => {
      const gains = stereoGains(value);
      if (smoothing > 0) {
        left.gain.setTargetAtTime(gains.left, when, smoothing);
        right.gain.setTargetAtTime(gains.right, when, smoothing);
      } else {
        left.gain.setValueAtTime(gains.left, when);
        right.gain.setValueAtTime(gains.right, when);
      }
    };
    const offset = clamp(options.offset, 0, Math.max(0, buffer.duration - 0.02));
    const startsAt = this.ctx.currentTime + Math.max(0, Number(options.delay) || 0);
    setPan(options.pan, startsAt);
    volume.gain.setValueAtTime(0.0001, startsAt);
    volume.gain.linearRampToValueAtTime(
      targetGain,
      startsAt + Math.max(0.002, Number(options.attack) || 0.004),
    );
    const maxDuration = Math.max(0, Number(options.maxDuration) || 0);
    if (!options.loop) {
      const duration = maxDuration || Math.max(0.02, buffer.duration - offset) / source.playbackRate.value;
      const fadeOut = Math.max(0, Number(options.fadeOut) || 0);
      if (fadeOut > 0 && duration > fadeOut + 0.02) {
        volume.gain.setValueAtTime(targetGain, startsAt + duration - fadeOut);
        volume.gain.linearRampToValueAtTime(0.0001, startsAt + duration);
      }
      if (maxDuration) source.stop(startsAt + maxDuration);
    }
    source.start(startsAt, offset);
    return {
      source, volume, low, high, setPan,
      baseRate: source.playbackRate.value,
      lastAt: startsAt,
    };
  }

  startFlight(event, playerIndex) {
    if (!event?.projectileId) return;
    this.stopFlight(event.projectileId);
    const buffer = this.buffers.get("flight");
    if (!buffer) return;
    const spatial = spatialFor(event, playerIndex);
    const state = flightAudioState(event, spatial);
    const voice = this.play("flight", {
      pan: state.pan,
      gain: state.gain,
      lowpass: state.lowpass,
      highpass: 58,
      playbackRate: state.playbackRate,
      attack: 0.008,
      loop: true,
      loopStart: Math.min(0.08, buffer.duration * 0.12),
      loopEnd: Math.max(0.1, buffer.duration - Math.min(0.07, buffer.duration * 0.1)),
    });
    if (!voice) return;
    voice.source.onended = () => {
      if (this.flights.get(event.projectileId)?.source === voice.source) {
        this.flights.delete(event.projectileId);
      }
    };
    this.flights.set(event.projectileId, voice);
  }

  async launch(event, playerIndex) {
    if (await this.ensure()) this.startFlight(event, playerIndex);
  }

  async flight(event, playerIndex) {
    if (!event?.projectileId) return;
    if (!this.flights.has(event.projectileId)) {
      if (!await this.ensure()) return;
      this.startFlight(event, playerIndex);
    }
    const voice = this.flights.get(event.projectileId);
    if (!voice) return;
    const state = flightAudioState(event, spatialFor(event, playerIndex));
    const now = this.ctx.currentTime;
    voice.setPan(state.pan, now, 0.018);
    voice.volume.gain.setTargetAtTime(state.gain, now, 0.035);
    voice.low.frequency.setTargetAtTime(state.lowpass, now, 0.045);
    voice.source.playbackRate.setTargetAtTime(state.playbackRate, now, 0.04);
    voice.lastAt = now;
  }

  async ricochet(event, playerIndex) {
    if (!await this.ensure()) return;
    const spatial = spatialFor(event, playerIndex);
    const state = flightAudioState(event, spatial);
    const voice = this.flights.get(event.projectileId);
    if (voice) {
      const now = this.ctx.currentTime;
      voice.setPan(state.pan, now, 0.006);
      voice.source.playbackRate.setTargetAtTime(clamp(state.playbackRate * 0.82, 0.5, 1.5), now, 0.012);
      voice.volume.gain.setTargetAtTime(state.gain * 1.08, now, 0.015);
    }
    this.play("flight", {
      pan: state.pan,
      gain: state.gain * 0.55,
      lowpass: event.surface === "shore" ? 5200 : 7600,
      highpass: 170,
      playbackRate: clamp(state.playbackRate * 0.7, 0.5, 1.3),
      attack: 0.002,
      fadeOut: 0.06,
      offset: 0,
      maxDuration: 0.16,
    });
  }

  stopFlight(id) {
    const voice = this.flights.get(id);
    if (!voice) return;
    try {
      const now = this.ctx?.currentTime || 0;
      voice.volume.gain.setTargetAtTime(0.0001, now, 0.016);
      voice.source.stop(now + 0.07);
    } catch (_) {}
    this.flights.delete(id);
  }

  async explode(event, playerIndex) {
    this.stopFlight(event?.projectileId);
    if (!await this.ensure()) return;
    const spatial = spatialFor(event, playerIndex);
    const plan = outdoorReflectionPlan(event, spatial);
    for (const layer of Object.values(plan)) {
      if (layer.gain <= 0) continue;
      this.play("explosion", layer);
    }
  }

  async confirmKills(count = 1) {
    await this.ensure();
    if (!this.buffers.has("kill")) return;
    const voices = Math.min(3, Math.max(1, Math.floor(Number(count) || 1)));
    for (let index = 0; index < voices; index += 1) {
      this.play("kill", {
        delay: index * 0.115,
        pan: index === 1 ? -0.08 : index === 2 ? 0.08 : 0,
        gain: index === 0 ? 0.98 : 0.78,
        highpass: 45,
        lowpass: 15500,
        attack: 0.004,
        fadeOut: 0.04,
      });
    }
  }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio();
  const seenKills = new Set();
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
    button.setAttribute("aria-label", `Запустить мега-бомбу. Зарядов: ${remaining}. Клавиша B.`);
    button.disabled = remaining <= 0;
  };
  const fire = async () => {
    await audio.ensure();
    if (globalThis.__freeRoamMegaBombBridge?.fire?.() !== true) {
      report("Сначала подключись к свободному миру.");
    }
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
    button.addEventListener("click", event => {
      event.preventDefault();
      fire();
    });
    controls.append(button);
    update();
  };
  document.addEventListener(
    "pointerdown",
    () => audio.ensure().catch(() => {}),
    {capture: true, once: true},
  );
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
    let killCount = 0;
    for (const gameEvent of message.events) {
      if (Number.isFinite(Number(gameEvent.remaining)) && gameEvent?.targets?.includes(playerIndex)) {
        remaining = Math.max(0, Math.floor(Number(gameEvent.remaining)));
        update();
      }
      if (gameEvent?.targets?.includes(playerIndex)) {
        if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
        else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
        else if (gameEvent.type === "mega-bomb-ricochet") audio.ricochet(gameEvent, playerIndex);
        else if (gameEvent.type === "mega-bomb-explosion") audio.explode(gameEvent, playerIndex);
        else if (gameEvent.type === "mega-bomb-denied") report(gameEvent.text || "Пуск недоступен.");
      }
      if (KILL_EVENT_TYPES.has(gameEvent?.type) && Number(gameEvent.sourcePlayer) === playerIndex) {
        const identity = eventIdentity(gameEvent);
        if (!seenKills.has(identity)) {
          seenKills.add(identity);
          killCount += 1;
        }
      }
    }
    if (seenKills.size > 160) {
      const keep = [...seenKills].slice(-96);
      seenKills.clear();
      for (const item of keep) seenKills.add(item);
    }
    if (killCount) audio.confirmKills(killCount);
  });
  new MutationObserver(addButton).observe(document.documentElement, {childList: true, subtree: true});
  addButton();
}

install();
