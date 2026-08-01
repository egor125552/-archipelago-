"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const TEST_AMMO = 100;
const SPEED_OF_SOUND = 343;
const LAND_RECT = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
const AUDIO_URLS = Object.freeze({
  flight: new URL("../audio/mega-bomb-flight-real-v1.mp3?v=2", import.meta.url).href,
  explosion: new URL("../audio/mega-bomb-explosion-real-v1.mp3?v=2", import.meta.url).href,
});
const KILL_AUDIO_PARTS = Object.freeze([
  new URL("../audio/enemy-killed-v1.part-00.b64?v=1", import.meta.url).href,
  new URL("../audio/enemy-killed-v1.part-01.b64?v=1", import.meta.url).href,
  new URL("../audio/enemy-killed-v1.part-02.b64?v=1", import.meta.url).href,
  new URL("../audio/enemy-killed-v1.part-03.b64?v=1", import.meta.url).href,
]);

export const KILL_EVENT_TYPES = Object.freeze(new Set([
  "enemy-boat-destroyed",
  "pursuer-destroyed",
  "gunner-destroyed",
  "hostile-actor-destroyed",
  "elite-destroyed",
  "heavy-turret-destroyed",
  "heavy-pursuer-destroyed",
]));

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (a, b) => Math.atan2((Number(b?.x) || 0) - (Number(a?.x) || 0), -((Number(b?.y) || 0) - (Number(a?.y) || 0))) * 180 / Math.PI;

function pointInsideRect(point, rect = LAND_RECT) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.minX && x <= rect.maxX
    && y >= rect.minY && y <= rect.maxY;
}

function segmentIntersectsRect(a, b, rect = LAND_RECT) {
  const x0 = Number(a?.x);
  const y0 = Number(a?.y);
  const x1 = Number(b?.x);
  const y1 = Number(b?.y);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  let near = 0;
  let far = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
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
  return !pointInsideRect(source)
    && !pointInsideRect(listener)
    && segmentIntersectsRect(source, listener);
}

function panFor(listener, point) {
  const relative = wrap(bearing(listener, point) - (Number(listener.heading) || 0));
  return clamp(Math.sin(relative * Math.PI / 180), -1, 1);
}

function shoreImages(source) {
  return [
    {surface: "west", x: LAND_RECT.minX * 2 - source.x, y: source.y},
    {surface: "east", x: LAND_RECT.maxX * 2 - source.x, y: source.y},
    {surface: "north", x: source.x, y: LAND_RECT.minY * 2 - source.y},
    {surface: "south", x: source.x, y: LAND_RECT.maxY * 2 - source.y},
  ];
}

function nearestDiffraction(source, listener) {
  const corners = [
    {surface: "north-west", x: LAND_RECT.minX, y: LAND_RECT.minY},
    {surface: "north-east", x: LAND_RECT.maxX, y: LAND_RECT.minY},
    {surface: "south-west", x: LAND_RECT.minX, y: LAND_RECT.maxY},
    {surface: "south-east", x: LAND_RECT.maxX, y: LAND_RECT.maxY},
  ];
  return corners
    .map(corner => ({...corner, pathDistance: distance(source, corner) + distance(corner, listener)}))
    .sort((left, right) => left.pathDistance - right.pathDistance)[0];
}

function airLowpass(metres) {
  return clamp(15500 - Math.max(0, metres) * 34, 2800, 15500);
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
  const directDelay = clamp(directDistance / SPEED_OF_SOUND, 0, 1.35);
  const occluded = hasGeometry && pathOccludedByLand(source, listener);

  const dry = {
    kind: "direct",
    delay: directDelay,
    pan: directPan,
    gain: directGain * (occluded ? 0.075 : 1),
    lowpass: occluded ? 680 : airLowpass(directDistance),
    highpass: occluded ? 80 : 28,
    occluded,
    duration: occluded ? 1.2 : null,
  };

  const sourceHeight = Math.max(0.2, Number(event.z) || 0.35);
  const listenerHeight = 1.45;
  const horizontal = Math.max(0.01, directDistance);
  const direct3d = Math.hypot(horizontal, listenerHeight - sourceHeight);
  const reflected3d = Math.hypot(horizontal, listenerHeight + sourceHeight);
  const waterCoefficient = event.surface === "ground" ? 0.07 : 0.16;
  const water = {
    kind: "water",
    delay: clamp(reflected3d / SPEED_OF_SOUND, directDelay + 0.0005, 1.38),
    pan: directPan,
    gain: directGain * waterCoefficient * (occluded ? 0.18 : 1),
    lowpass: event.surface === "ground" ? 4300 : 7600,
    highpass: 70,
    duration: 0.48,
  };

  let shores;
  if (hasGeometry) {
    shores = shoreImages(source)
      .map(image => {
        const pathDistance = distance(listener, image);
        const extraDistance = Math.max(0, pathDistance - directDistance);
        return {
          surface: image.surface,
          delay: clamp(pathDistance / SPEED_OF_SOUND, directDelay + 0.018, 1.65),
          pan: panFor(listener, image),
          extraDistance,
          pathDistance,
        };
      })
      .sort((left, right) => left.pathDistance - right.pathDistance)
      .slice(0, 2);
  } else {
    shores = [
      {surface: "near", delay: directDelay + 0.15, pan: clamp(-directPan * 0.5, -1, 1), extraDistance: 48},
      {surface: "far", delay: directDelay + 0.29, pan: clamp(directPan * 0.35, -1, 1), extraDistance: 92},
    ];
  }

  const shoreNear = {
    kind: "shore-near",
    surface: shores[0].surface,
    delay: shores[0].delay,
    pan: shores[0].pan,
    gain: directGain * 0.18 * clamp(1 / (1 + shores[0].extraDistance / 105), 0.16, 1),
    lowpass: 4600,
    highpass: 58,
    duration: 1.05,
  };
  const shoreFar = {
    kind: "shore-far",
    surface: shores[1].surface,
    delay: Math.max(shores[1].delay, shoreNear.delay + 0.035),
    pan: shores[1].pan,
    gain: directGain * 0.105 * clamp(1 / (1 + shores[1].extraDistance / 135), 0.12, 1),
    lowpass: 2900,
    highpass: 52,
    duration: 0.78,
  };

  const corner = hasGeometry ? nearestDiffraction(source, listener) : null;
  const diffractionExtra = corner ? Math.max(0, corner.pathDistance - directDistance) : 0;
  const diffraction = {
    kind: "diffraction",
    surface: corner?.surface || "none",
    delay: corner ? clamp(corner.pathDistance / SPEED_OF_SOUND, directDelay + 0.02, 1.8) : directDelay,
    pan: corner ? panFor(listener, corner) : directPan,
    gain: occluded ? directGain * 0.3 * clamp(1 / (1 + diffractionExtra / 85), 0.18, 1) : 0,
    lowpass: 1850,
    highpass: 72,
    duration: 1.25,
  };

  return {dry, water, shoreNear, shoreFar, diffraction};
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

function eventIdentity(event) {
  return [
    event?.type,
    Number(event?.at) || 0,
    event?.actorId || event?.gunnerId || event?.pursuerId || event?.sourcePursuerId || event?.projectileId || "",
  ].join(":");
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
      compressor.threshold.value = -7;
      compressor.knee.value = 5;
      compressor.ratio.value = 7;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.34;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.94;
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) this.loading = this.loadBuffers();
    await this.loading;
    return this.buffers.size === Object.keys(AUDIO_URLS).length + 1;
  }

  async loadBuffers() {
    try {
      const entries = await Promise.all(Object.entries(AUDIO_URLS).map(async ([name, url]) => {
        const response = await fetch(url, {cache: "force-cache"});
        if (!response.ok) throw new Error(`Game audio ${name}: ${response.status}`);
        const decoded = await this.ctx.decodeAudioData((await response.arrayBuffer()).slice(0));
        return [name, decoded];
      }));
      const encodedParts = await Promise.all(KILL_AUDIO_PARTS.map(async url => {
        const response = await fetch(url, {cache: "force-cache"});
        if (!response.ok) throw new Error(`Kill audio part: ${response.status}`);
        return (await response.text()).trim();
      }));
      const binary = atob(encodedParts.join(""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      entries.push(["kill", await this.ctx.decodeAudioData(bytes.buffer.slice(0))]);
      for (const [name, buffer] of entries) this.buffers.set(name, buffer);
    } catch (error) {
      console.warn("Не удалось загрузить реальные записи мегабомбы или подтверждения убийства", error);
    }
  }

  playRecording(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master || Number(options.gain) <= 0) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(options.playbackRate ?? 1, 0.55, 1.55);
    const high = this.ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = Math.max(20, Number(options.highpass) || 28);
    const low = this.ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = Math.max(200, Number(options.lowpass) || 15500);
    const gain = this.ctx.createGain();
    gain.gain.value = clamp(options.gain ?? 1, 0, 1.4);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(options.pan, -1, 1);
    source.connect(high).connect(low).connect(gain).connect(panner).connect(this.master);
    const offset = clamp(options.offset, 0, Math.max(0, buffer.duration - 0.02));
    const delay = Math.max(0, Number(options.delay) || 0);
    const maximumDuration = Math.max(0.02, buffer.duration - offset);
    const requestedDuration = Number(options.duration);
    if (Number.isFinite(requestedDuration) && requestedDuration > 0) {
      source.start(this.ctx.currentTime + delay, offset, Math.min(maximumDuration, requestedDuration));
    } else {
      source.start(this.ctx.currentTime + delay, offset);
    }
    return {source, gain, panner, high, low, buffer, baseRate: source.playbackRate.value};
  }

  flightOccluded(event, spatial) {
    const listener = {x: spatial.listenerX, y: spatial.listenerY};
    return Number.isFinite(listener.x) && Number.isFinite(listener.y)
      && pathOccludedByLand(event, listener);
  }

  startFlight(event, playerIndex, progress = 0) {
    if (!event?.projectileId || !this.ctx) return;
    this.stopFlight(event.projectileId);
    const buffer = this.buffers.get("flight");
    if (!buffer) return;
    const spatial = spatialFor(event, playerIndex);
    const flightTime = clamp(event.flightTime, 0.7, 2.75);
    const ratio = clamp(progress, 0, 0.96);
    const remaining = Math.max(0.12, flightTime * (1 - ratio));
    const offset = buffer.duration * ratio;
    const occluded = this.flightOccluded(event, spatial);
    const voice = this.playRecording("flight", {
      pan: spatial.pan,
      gain: (0.12 + spatial.gain * 0.44) * (occluded ? 0.18 : 1),
      highpass: occluded ? 120 : 75,
      lowpass: occluded ? 900 : airLowpass(spatial.distance),
      playbackRate: clamp((buffer.duration - offset) / remaining, 0.55, 1.55),
      offset,
    });
    if (!voice) return;
    voice.lastDistance = spatial.distance;
    voice.lastAt = this.ctx.currentTime;
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
      this.startFlight(event, playerIndex, clamp(event.progress, 0, 1));
    }
    const voice = this.flights.get(event.projectileId);
    if (!voice) return;
    const spatial = spatialFor(event, playerIndex);
    const now = this.ctx.currentTime;
    const occluded = this.flightOccluded(event, spatial);
    const elapsed = Math.max(0.02, now - (voice.lastAt || now));
    const radialSpeed = ((voice.lastDistance ?? spatial.distance) - spatial.distance) / elapsed;
    const doppler = clamp(SPEED_OF_SOUND / Math.max(260, SPEED_OF_SOUND - radialSpeed), 0.88, 1.14);
    voice.panner.pan.setTargetAtTime(spatial.pan, now, 0.04);
    voice.gain.gain.setTargetAtTime((0.1 + spatial.gain * 0.48) * (occluded ? 0.18 : 1), now, 0.05);
    voice.low.frequency.setTargetAtTime(occluded ? 900 : airLowpass(spatial.distance), now, 0.05);
    voice.source.playbackRate.setTargetAtTime(clamp(voice.baseRate * doppler, 0.55, 1.55), now, 0.06);
    voice.lastDistance = spatial.distance;
    voice.lastAt = now;
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

  async explode(event, playerIndex) {
    this.stopFlight(event?.projectileId);
    if (!await this.ensure()) return;
    const plan = outdoorReflectionPlan(event, spatialFor(event, playerIndex));
    this.playRecording("explosion", plan.dry);
    this.playRecording("explosion", plan.water);
    this.playRecording("explosion", plan.shoreNear);
    this.playRecording("explosion", plan.shoreFar);
    this.playRecording("explosion", plan.diffraction);
  }

  async confirmKills(count = 1) {
    if (!await this.ensure()) return;
    const voices = Math.min(3, Math.max(1, Math.floor(Number(count) || 1)));
    for (let index = 0; index < voices; index += 1) {
      this.playRecording("kill", {
        delay: index * 0.115,
        pan: index === 1 ? -0.08 : index === 2 ? 0.08 : 0,
        gain: index === 0 ? 0.98 : 0.78,
        highpass: 45,
        lowpass: 15500,
      });
    }
  }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio();
  const seenKillEvents = new Set();
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
        if (!seenKillEvents.has(identity)) {
          seenKillEvents.add(identity);
          killCount += 1;
        }
      }
    }
    if (seenKillEvents.size > 160) {
      const keep = [...seenKillEvents].slice(-96);
      seenKillEvents.clear();
      for (const value of keep) seenKillEvents.add(value);
    }
    if (killCount > 0) audio.confirmKills(killCount);
  });
  new MutationObserver(addButton).observe(document.documentElement, {childList: true, subtree: true});
  addButton();
}

install();
