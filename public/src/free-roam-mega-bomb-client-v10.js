"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TEST_AMMO = 25;
const SPEED_OF_SOUND = 343;
const LAND_RECT = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
const FLIGHT_URL = new URL("../audio/mega-bomb-flight-real-v1.mp3?v=4", import.meta.url).href;
const EXPLOSION_URL = new URL("../audio/mega-bomb-explosion-v7.mp3?v=7", import.meta.url).href;
const FALLBACK_EXPLOSION_URL = new URL("../audio/mega-bomb-explosion-real-v1.mp3?v=4", import.meta.url).href;
const KILL_URL = new URL("../audio/enemy-killed-v2.mp3?v=2", import.meta.url).href;

export const KILL_EVENT_TYPES = Object.freeze(new Set([
  "enemy-boat-destroyed", "pursuer-destroyed", "gunner-destroyed",
  "hostile-actor-destroyed", "elite-destroyed", "heavy-turret-destroyed",
  "heavy-pursuer-destroyed",
]));

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

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

function airLowpass(metres) {
  return clamp(15800 - Math.max(0, metres) * 30, 2600, 15800);
}

export function outdoorReflectionPlan(event = {}, spatial = {}) {
  const source = {x: Number(event.x) || 0, y: Number(event.y) || 0};
  const listener = {x: Number(spatial.listenerX), y: Number(spatial.listenerY)};
  const hasGeometry = Number.isFinite(listener.x) && Number.isFinite(listener.y);
  const metres = Math.max(0, Number(spatial.distance) || (hasGeometry ? distance(source, listener) : 0));
  const delay = clamp(metres / SPEED_OF_SOUND, 0, 1.35);
  const pan = clamp(spatial.pan, -1, 1);
  const gain = clamp(spatial.gain, 0, 1);
  const occluded = hasGeometry && pathOccludedByLand(source, listener);
  return {
    delay,
    pan,
    gain: gain * (occluded ? 0.14 : 1.06),
    lowpass: occluded ? 720 : airLowpass(metres),
    highpass: occluded ? 82 : 22,
    offset: 0,
    attack: 0,
    fadeOut: 0.5,
  };
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

function projectileSide(event) {
  if (Number(event?.audioArcSide) === -1) return -1;
  if (Number(event?.audioArcSide) === 1) return 1;
  const text = String(event?.projectileId || event?.id || "mega-bomb-1");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return (hash & 1) ? 1 : -1;
}

export function cinematicFlightPan(event, playerIndex) {
  const spatial = spatialFor(event, playerIndex);
  const progress = clamp(event?.progress, 0, 1);
  const side = projectileSide(event);
  const arcStrength = clamp(event?.audioArcStrength ?? 0.86, 0.35, 1);
  const arc = side * Math.sin(Math.PI * progress) * 0.82 * arcStrength;
  const geometry = Math.sign(spatial.pan) * Math.pow(Math.abs(spatial.pan), 0.58);
  return clamp(geometry * 0.82 + arc, -1, 1);
}

function eventIdentity(event) {
  return [event?.type, Number(event?.at) || 0,
    event?.actorId || event?.gunnerId || event?.pursuerId
      || event?.sourcePursuerId || event?.projectileId || ""].join(":");
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
    const channels = Array.from({length: buffer.numberOfChannels}, (_, channel) => buffer.getChannelData(channel));
    for (let index = 0; index < output.length; index += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[index] || 0;
      output[index] = sum / channels.length;
    }
    return mono;
  }

  async decodeAndStore(name, bytes) {
    const decoded = await this.ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(name, this.toMono(decoded));
  }

  async loadUrl(name, url) {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`${name}: файл слишком короткий (${bytes.byteLength})`);
    await this.decodeAndStore(name, bytes);
  }

  async loadExplosion() {
    try {
      await this.loadUrl("explosion", EXPLOSION_URL);
    } catch (error) {
      console.warn("Новый взрыв не загрузился; использую резервный MP3", error);
      await this.loadUrl("explosion", FALLBACK_EXPLOSION_URL);
    }
  }

  async loadKillRecording() {
    try {
      await this.loadUrl("kill", KILL_URL);
    } catch (error) {
      console.warn("Не удалось загрузить подтверждение уничтожения", error);
    }
  }

  async loadBuffers() {
    await Promise.all([
      this.loadUrl("flight", FLIGHT_URL).catch(error => console.warn("Не удалось загрузить полёт", error)),
      this.loadExplosion(),
      this.loadKillRecording(),
    ]);
  }

  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master) return null;
    const targetGain = clamp(options.gain ?? 1, 0, 1.35);
    if (targetGain <= 0) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(options.playbackRate ?? 1, 0.55, 1.6);

    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = Math.max(20, Number(options.highpass) || 22);
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = Math.max(200, Number(options.lowpass) || 15800);
    const volume = this.ctx.createGain();
    source.connect(high).connect(low).connect(volume);

    let setPan;
    if (typeof this.ctx.createStereoPanner === "function") {
      const panner = this.ctx.createStereoPanner();
      volume.connect(panner).connect(this.master);
      setPan = (value, when = this.ctx.currentTime, smoothing = 0) => {
        const pan = clamp(value, -1, 1);
        if (smoothing > 0) panner.pan.setTargetAtTime(pan, when, smoothing);
        else panner.pan.setValueAtTime(pan, when);
      };
    } else {
      const left = this.ctx.createGain();
      const right = this.ctx.createGain();
      const merger = this.ctx.createChannelMerger(2);
      volume.connect(left);
      volume.connect(right);
      left.connect(merger, 0, 0);
      right.connect(merger, 0, 1);
      merger.connect(this.master);
      setPan = (value, when = this.ctx.currentTime, smoothing = 0) => {
        const pan = clamp(value, -1, 1);
        const angle = (pan + 1) * Math.PI / 4;
        const leftGain = Math.cos(angle);
        const rightGain = Math.sin(angle);
        if (smoothing > 0) {
          left.gain.setTargetAtTime(leftGain, when, smoothing);
          right.gain.setTargetAtTime(rightGain, when, smoothing);
        } else {
          left.gain.setValueAtTime(leftGain, when);
          right.gain.setValueAtTime(rightGain, when);
        }
      };
    }

    const offset = clamp(options.offset, 0, Math.max(0, buffer.duration - 0.02));
    const startsAt = this.ctx.currentTime + Math.max(0, Number(options.delay) || 0);
    const sourceDuration = Math.max(0.02, buffer.duration - offset);
    const endsAt = startsAt + sourceDuration / source.playbackRate.value;
    setPan(options.pan, startsAt);

    const attack = Math.max(0, Number(options.attack) || 0);
    const fadeOut = Math.max(0, Number(options.fadeOut) || 0);
    if (attack > 0) {
      volume.gain.setValueAtTime(0.0001, startsAt);
      volume.gain.linearRampToValueAtTime(targetGain, startsAt + attack);
    } else {
      volume.gain.setValueAtTime(targetGain, startsAt);
    }
    if (fadeOut > 0 && endsAt - startsAt > fadeOut + attack) {
      volume.gain.setValueAtTime(targetGain, endsAt - fadeOut);
      volume.gain.linearRampToValueAtTime(0.0001, endsAt);
    }
    source.start(startsAt, offset);
    return {source, volume, low, setPan, baseRate: source.playbackRate.value, lastAt: startsAt};
  }

  startFlight(event, playerIndex, progress = 0) {
    if (!event?.projectileId) return;
    this.stopFlight(event.projectileId);
    const buffer = this.buffers.get("flight");
    if (!buffer) return;
    const spatial = spatialFor(event, playerIndex);
    const ratio = clamp(progress, 0, 0.96);
    const flightTime = clamp(event.flightTime, 0.8, 4.2);
    const remaining = Math.max(0.12, flightTime * (1 - ratio));
    const offset = buffer.duration * ratio;
    const voice = this.play("flight", {
      pan: cinematicFlightPan({...event, progress: ratio}, playerIndex),
      gain: 0.03 + Math.pow(spatial.gain, 1.12) * 0.82,
      lowpass: airLowpass(spatial.distance),
      highpass: 62,
      offset,
      playbackRate: clamp((buffer.duration - offset) / remaining, 0.55, 1.6),
      attack: 0.008,
      fadeOut: 0.045,
    });
    if (!voice) return;
    voice.lastDistance = spatial.distance;
    voice.source.onended = () => {
      if (this.flights.get(event.projectileId)?.source === voice.source) this.flights.delete(event.projectileId);
    };
    this.flights.set(event.projectileId, voice);
  }

  async launch(event, playerIndex) {
    if (await this.ensure()) this.startFlight(event, playerIndex, 0);
  }

  async flight(event, playerIndex) {
    if (!event?.projectileId) return;
    if (!this.flights.has(event.projectileId)) {
      if (!await this.ensure()) return;
      this.startFlight(event, playerIndex, event.progress);
    }
    const voice = this.flights.get(event.projectileId);
    if (!voice) return;
    const spatial = spatialFor(event, playerIndex);
    const now = this.ctx.currentTime;
    const elapsed = Math.max(0.02, now - (voice.lastAt || now));
    const radialSpeed = ((voice.lastDistance ?? spatial.distance) - spatial.distance) / elapsed;
    const doppler = clamp(SPEED_OF_SOUND / Math.max(255, SPEED_OF_SOUND - radialSpeed), 0.86, 1.17);
    voice.setPan(cinematicFlightPan(event, playerIndex), now, 0.026);
    voice.volume.gain.setTargetAtTime(0.03 + Math.pow(spatial.gain, 1.12) * 0.82, now, 0.045);
    voice.low.frequency.setTargetAtTime(airLowpass(spatial.distance), now, 0.05);
    voice.source.playbackRate.setTargetAtTime(clamp(voice.baseRate * doppler, 0.55, 1.6), now, 0.055);
    voice.lastDistance = spatial.distance;
    voice.lastAt = now;
  }

  stopFlight(id) {
    const voice = this.flights.get(id);
    if (!voice) return;
    try {
      const now = this.ctx?.currentTime || 0;
      voice.volume.gain.setTargetAtTime(0.0001, now, 0.012);
      voice.source.stop(now + 0.055);
    } catch (_) {}
    this.flights.delete(id);
  }

  async explode(event, playerIndex) {
    this.stopFlight(event?.projectileId);
    if (!await this.ensure()) return;
    this.play("explosion", outdoorReflectionPlan(event, spatialFor(event, playerIndex)));
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
    let killCount = 0;
    for (const gameEvent of message.events) {
      if (Number.isFinite(Number(gameEvent.remaining)) && gameEvent?.targets?.includes(playerIndex)) {
        remaining = Math.max(0, Math.floor(Number(gameEvent.remaining)));
        update();
      }
      if (gameEvent?.targets?.includes(playerIndex)) {
        if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
        else if (gameEvent.type === "mega-bomb-flight") audio.flight(gameEvent, playerIndex);
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
