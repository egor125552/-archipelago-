"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=44";

const EVENT_NAME = "free-roam-mega-bomb-message";
const FLIGHT_URL = new URL("../audio/mega-bomb-flight-real-v1.mp3?v=6", import.meta.url).href;
const EXPLOSION_URL = new URL("../audio/mega-bomb-explosion-v12.mp3?v=14", import.meta.url).href;
const TERMINAL_MS = 12000;
const AUDIO_GRAPH_EVENT = "free-roam-audio-graph-ready";
const AUDIO_PATCH_FLAG = Symbol.for("echo.freeRoam.megaBombSharedAudio");

let sharedAudioEngine = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function publishSharedAudioEngine(engine) {
  if (!engine) return;
  sharedAudioEngine = engine;
  globalThis.__freeRoamAudioEngine = engine;
  try { globalThis.dispatchEvent(new Event(AUDIO_GRAPH_EVENT)); } catch (_) {}
}

function installSharedAudioBridge() {
  const prototype = FreeRoamAudio?.prototype;
  if (!prototype || prototype[AUDIO_PATCH_FLAG]) return;
  Object.defineProperty(prototype, AUDIO_PATCH_FLAG, {value: true});

  const originalInit = prototype.init;
  if (typeof originalInit === "function") {
    prototype.init = async function sharedAudioInit(...args) {
      publishSharedAudioEngine(this);
      const result = await originalInit.apply(this, args);
      publishSharedAudioEngine(this);
      return result;
    };
  }

  const originalUpdateWorld = prototype.updateWorld;
  if (typeof originalUpdateWorld === "function") {
    prototype.updateWorld = function sharedAudioUpdateWorld(...args) {
      publishSharedAudioEngine(this);
      return originalUpdateWorld.apply(this, args);
    };
  }
}

function currentAudioGraph() {
  const engine = sharedAudioEngine || globalThis.__freeRoamAudioEngine;
  if (!engine?.ctx || !engine?.master) return null;
  return {engine, ctx: engine.ctx, input: engine.master};
}

async function waitForAudioGraph(timeoutMs = 2400) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const graph = currentAudioGraph();
    if (graph) return graph;
    await sleep(40);
  }
  return currentAudioGraph();
}

installSharedAudioBridge();

function panGains(value) {
  const pan = Math.sign(clamp(value, -1, 1)) * Math.pow(Math.abs(clamp(value, -1, 1)), 0.68);
  const angle = (pan + 1) * Math.PI / 4;
  return {left: Math.cos(angle), right: Math.sin(angle)};
}

function coordinateDistance(event, value) {
  const sourceX = Number(event?.x);
  const sourceY = Number(event?.y);
  const sourceZ = Math.max(0, Number(event?.z) || 0);
  const listenerX = Number(value?.listenerX);
  const listenerY = Number(value?.listenerY);
  if ([sourceX, sourceY, listenerX, listenerY].every(Number.isFinite)) {
    return Math.hypot(sourceX - listenerX, sourceY - listenerY, sourceZ);
  }
  return Math.max(0, Number(value?.distance) || 0);
}

export function spatialState(event, playerIndex, kind) {
  const value = event?.spatial?.[playerIndex] || {};
  const distance = coordinateDistance(event, value);
  const speed = Math.max(0, Number(value.speed) || Number(event?.speed) || Math.hypot(
    Number(event?.vx) || 0,
    Number(event?.vy) || 0,
    Number(event?.vz) || 0,
  ));
  const radial = Number(value.radialSpeed) || 0;
  const doppler = clamp(343 / Math.max(250, 343 + radial), 0.88, 1.14);
  const occluded = Boolean(value.occluded);
  const explosion = kind === "explosion";
  const attenuation = explosion
    ? Math.pow(1 + distance / 48, -1.72)
    : Math.pow(1 + distance / 28, -1.82);
  const motion = explosion ? 1 : Math.pow(clamp(speed / 45, 0.28, 1.18), 0.48);
  const gain = clamp(attenuation * motion * (occluded ? 0.2 : 1), 0, explosion ? 1.18 : 0.92);
  const lowpass = occluded
    ? (explosion ? 820 : 620)
    : clamp(
      (explosion ? 17400 : 15800) - distance * (explosion ? 54 : 62),
      explosion ? 1050 : 700,
      explosion ? 17400 : 15800,
    );
  return {
    pan: clamp(value.pan ?? event?.pan, -1, 1),
    gain,
    lowpass,
    highpass: explosion ? 24 : clamp(48 + speed * 1.05, 50, 128),
    rate: explosion ? 1 : clamp((0.58 + speed / 68) * doppler, 0.58, 1.42),
    distance,
  };
}

class MegaBombAudio {
  constructor() {
    this.ctx = null;
    this.output = null;
    this.sharedInput = null;
    this.buffers = new Map();
    this.loading = null;
    this.flights = new Map();
    this.impacts = new Map();
    this.terminal = new Map();
  }

  useSharedGraph(graph) {
    if (!graph?.ctx || !graph?.input) return false;
    if (this.ctx === graph.ctx && this.sharedInput === graph.input && this.output) return true;

    this.reset();
    try { this.output?.disconnect?.(); } catch (_) {}
    this.ctx = graph.ctx;
    this.sharedInput = graph.input;
    this.output = this.ctx.createGain();
    this.output.gain.value = 0.92;
    this.output.connect(this.sharedInput);
    this.buffers.clear();
    this.loading = null;
    return true;
  }

  async ensure() {
    const graph = currentAudioGraph() || await waitForAudioGraph();
    if (!this.useSharedGraph(graph)) {
      console.warn("Общий аудиодвижок ещё не готов: звук мегабомбы не запускается отдельно.");
      return false;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.loading) {
      this.loading = Promise.all([
        this.load("flight", FLIGHT_URL),
        this.load("explosion", EXPLOSION_URL),
      ]).catch(error => {
        this.loading = null;
        console.error("Не удалось загрузить звуки мегабомбы", error);
      });
    }
    await this.loading;
    return this.buffers.has("flight") && this.buffers.has("explosion");
  }

  async load(name, url) {
    const response = await fetch(url, {cache: "reload"});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html")) throw new Error(`${name}: вместо MP3 получен HTML`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`${name}: файл слишком короткий`);
    const decoded = await this.ctx.decodeAudioData(bytes.slice(0));
    if (decoded.numberOfChannels <= 1) {
      this.buffers.set(name, decoded);
      return;
    }
    const mono = this.ctx.createBuffer(1, decoded.length, decoded.sampleRate);
    const output = mono.getChannelData(0);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const input = decoded.getChannelData(channel);
      for (let index = 0; index < output.length; index += 1) {
        output[index] += input[index] / decoded.numberOfChannels;
      }
    }
    this.buffers.set(name, mono);
  }

  play(name, options = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.output) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = Boolean(options.loop);
    if (source.loop && buffer.duration > 0.18) {
      source.loopStart = 0.06;
      source.loopEnd = buffer.duration - 0.06;
    }
    source.playbackRate.value = clamp(options.rate ?? 1, 0.5, 1.5);
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
    merger.connect(this.output);
    const setPan = (value, when = this.ctx.currentTime, smoothing = 0) => {
      const gains = panGains(value);
      if (smoothing > 0) {
        left.gain.setTargetAtTime(gains.left, when, smoothing);
        right.gain.setTargetAtTime(gains.right, when, smoothing);
      } else {
        left.gain.setValueAtTime(gains.left, when);
        right.gain.setValueAtTime(gains.right, when);
      }
    };
    const now = this.ctx.currentTime;
    const gain = clamp(options.gain, 0, 1.2);
    setPan(options.pan, now);
    volume.gain.setValueAtTime(0.0001, now);
    volume.gain.linearRampToValueAtTime(
      Math.max(0.0001, gain),
      now + Math.max(0.004, Number(options.attack) || 0.012),
    );
    source.start(now);
    return {source, volume, low, high, setPan, timer: null};
  }

  isTerminal(id) {
    const until = this.terminal.get(id) || 0;
    if (until > performance.now()) return true;
    if (until) this.terminal.delete(id);
    return false;
  }

  stopFlight(id, remember = false) {
    const key = String(id || "");
    if (remember) this.terminal.set(key, performance.now() + TERMINAL_MS);
    const voice = this.flights.get(key);
    if (!voice) return;
    if (voice.timer) clearTimeout(voice.timer);
    try {
      const now = this.ctx.currentTime;
      voice.volume.gain.setTargetAtTime(0.0001, now, 0.018);
      voice.source.stop(now + 0.07);
    } catch (_) {}
    this.flights.delete(key);
  }

  apply(voice, state, smoothing = 0.04) {
    if (!voice || !this.ctx) return;
    const now = this.ctx.currentTime;
    voice.setPan(state.pan, now, smoothing * 0.45);
    voice.volume.gain.setTargetAtTime(Math.max(0.0001, state.gain), now, smoothing);
    voice.low.frequency.setTargetAtTime(state.lowpass, now, smoothing);
    voice.high.frequency.setTargetAtTime(state.highpass, now, smoothing);
    voice.source.playbackRate.setTargetAtTime(state.rate, now, smoothing);
  }

  async launch(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id) || !await this.ensure()) return;
    this.stopFlight(id);
    const state = spatialState(event, playerIndex, "flight");
    const voice = this.play("flight", {...state, loop: true, attack: 0.02});
    if (!voice) return;
    const remaining = clamp(
      (Number(event.maxAge) || 0) - (Number(event.age) || 0) + 0.8,
      0.5,
      12,
    );
    voice.timer = setTimeout(() => this.stopFlight(id, true), remaining * 1000);
    voice.source.onended = () => {
      if (this.flights.get(id)?.source === voice.source) this.flights.delete(id);
    };
    this.flights.set(id, voice);
  }

  async flight(event, playerIndex) {
    const id = String(event?.projectileId || "");
    if (!id || this.isTerminal(id)) return;
    if (!this.flights.has(id)) await this.launch(event, playerIndex);
    this.apply(this.flights.get(id), spatialState(event, playerIndex, "flight"), 0.035);
  }

  async explode(event, playerIndex) {
    const id = String(event?.projectileId || "");
    this.stopFlight(id, true);
    if (!await this.ensure()) return;
    const existing = this.impacts.get(id);
    if (existing) {
      try { existing.source.stop(); } catch (_) {}
      this.impacts.delete(id);
    }
    const state = spatialState(event, playerIndex, "explosion");
    const voice = this.play("explosion", {...state, loop: false, attack: 0.003});
    if (!voice) return;
    voice.source.onended = () => {
      if (this.impacts.get(id)?.source === voice.source) this.impacts.delete(id);
    };
    this.impacts.set(id, voice);
  }

  updateImpact(event, playerIndex) {
    const id = String(event?.projectileId || "");
    const voice = this.impacts.get(id);
    if (!voice) return;
    this.apply(voice, spatialState(event, playerIndex, "explosion"), 0.055);
  }

  reset() {
    for (const id of [...this.flights.keys()]) this.stopFlight(id);
    for (const voice of this.impacts.values()) {
      try { voice.source.stop(); } catch (_) {}
    }
    this.impacts.clear();
    this.terminal.clear();
  }
}

function install() {
  if (typeof document === "undefined" || globalThis.__freeRoamMegaBombClientInstalled) return;
  globalThis.__freeRoamMegaBombClientInstalled = true;
  const audio = new MegaBombAudio();
  let playerIndex = 0;
  let remaining = 25;
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
    const ready = await audio.ensure();
    if (!ready) {
      report("Аудиодвижок ещё запускается. Повтори пуск.");
      return;
    }
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
  document.addEventListener("pointerdown", () => audio.ensure().catch(() => {}), {
    capture: true,
    once: true,
  });
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
      audio.reset();
      playerIndex = message.role === "crew" ? 1 : 0;
      addButton();
      return;
    }
    if (message.type === "network-closed") {
      audio.reset();
      return;
    }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (Number.isFinite(Number(gameEvent.remaining)) && gameEvent?.targets?.includes(playerIndex)) {
        remaining = Math.max(0, Math.floor(Number(gameEvent.remaining)));
        update();
      }
      if (!gameEvent?.targets?.includes(playerIndex)) continue;
      if (gameEvent.type === "mega-bomb-launch") audio.launch(gameEvent, playerIndex);
      else if (gameEvent.type === "mega-bomb-flight" || gameEvent.type === "mega-bomb-ricochet") {
        audio.flight(gameEvent, playerIndex);
      } else if (gameEvent.type === "mega-bomb-explosion") {
        audio.explode(gameEvent, playerIndex);
      } else if (gameEvent.type === "mega-bomb-explosion-spatial") {
        audio.updateImpact(gameEvent, playerIndex);
      } else if (gameEvent.type === "mega-bomb-denied") {
        report(gameEvent.text || "Пуск недоступен.");
      }
    }
  });
  new MutationObserver(addButton).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addButton();
}

install();
