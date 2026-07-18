"use strict";

import {AudioEngine} from "./audio-engine-v13.js?free=2";

const FOOTSTEPS = Object.freeze({
  footstepFree1: "/api/sound/footstep-1.ogg",
  footstepFree2: "/api/sound/footstep-2.ogg",
  footstepFree3: "/api/sound/footstep-3.ogg",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export function operationEventForFreeEvent(event) {
  switch (event?.type) {
    case "collision":
    case "ram":
      return {type: "collision", severity: Math.max(0.55, event.strength || 1), impactSpeed: event.strength || 0, hardImpact: (event.strength || 0) >= 5};
    case "tow-attach": return {type: "rope"};
    case "tow-strain": return {type: "rope-strain", speed: event.tension || 1};
    case "tow-detach": return {type: "rope-far"};
    case "pump-start": return {type: "pump-start"};
    case "hull-repair-start": return {type: "hull-repair-start"};
    case "hull-repair-progress": return {type: "hull-repair-progress", percent: event.percent || 0};
    case "hull-repair-complete": return {type: "hull-repair-complete"};
    case "repair-blocked": return {type: "repair-blocked"};
    case "engine-flooded": return {type: "engine-flooded"};
    case "engine-water-restart": return {type: "engine-water-restart"};
    case "flood-emergency-start": return {type: "flood-emergency-start", cause: event.cause || "flooded"};
    case "flood-emergency-warning": return {type: "flood-emergency-warning", critical: Boolean(event.critical)};
    case "flood-emergency-recovered": return {type: "flood-emergency-recovered"};
    case "flood-emergency-failed": return {type: "flood-emergency-failed"};
    default: return null;
  }
}

export class FreeRoamAudio extends AudioEngine {
  constructor() {
    super();
    this.footstepIndex = 0;
    this.footstepPreloadPromise = null;
    this.remote = null;
    this.remoteWake = null;
  }

  async init() {
    await super.init();
    if (this.footstepPreloadPromise) await this.footstepPreloadPromise;
  }

  async preload() {
    const inherited = super.preload();
    if (!this.ctx) return inherited;
    this.footstepPreloadPromise = Promise.allSettled(Object.entries(FOOTSTEPS).map(async ([name, url]) => {
      const response = await fetch(url, {cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      this.buffers.set(name, await this.ctx.decodeAudioData(await response.arrayBuffer()));
    }));
    await Promise.allSettled([inherited, this.footstepPreloadPromise]);
  }

  nextFootstep() {
    const available = Object.keys(FOOTSTEPS).filter(name => this.buffers.has(name));
    if (!available.length) return this.buffers.has("hullCreak") ? "hullCreak" : null;
    const name = available[this.footstepIndex % available.length];
    this.footstepIndex += 1;
    return name;
  }

  playFootstep({gain = 0.22, rate = 1, pan = 0} = {}) {
    const name = this.nextFootstep();
    if (!name) return;
    this.play(name, {gain, rate, pan, lowpass: 7200});
  }

  startRemoteLoop(name, bufferName) {
    if (this[name] || !this.ctx || !this.master || !this.buffers.has(bufferName)) return;
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();
    const gain = this.ctx.createGain();
    source.buffer = this.buffers.get(bufferName);
    source.loop = true;
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    gain.gain.value = 0;
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start();
    this[name] = {source, filter, panner, gain};
  }

  stopRemoteLoop(name) {
    const loop = this[name];
    if (!loop) return;
    try { loop.source.stop(); } catch (_) {}
    this[name] = null;
  }

  updateRemote(world, playerIndex) {
    if (!this.ctx || !world) return;
    const me = world.players?.[playerIndex];
    const other = world.players?.[1 - playerIndex];
    const otherBoat = other && ["boat", "roof"].includes(other.mode) ? world.boats?.[other.activeBoat] : null;
    const audible = Boolean(me && otherBoat && !otherBoat.sunk && distance(me, otherBoat) < 150);
    if (!audible) {
      if (this.remote) this.remote.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
      if (this.remoteWake) this.remoteWake.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
      return;
    }

    this.startRemoteLoop("remote", "motorboatReal");
    this.startRemoteLoop("remoteWake", this.buffers.has("riverWake") ? "riverWake" : "seaReal");
    const metres = distance(me, otherBoat);
    const proximity = clamp(1 - metres / 150, 0, 1);
    const speed = Math.abs(Number(otherBoat.speed) || 0);
    const throttle = Math.abs(Number(otherBoat.throttle) || 0);
    const pan = clamp((otherBoat.x - me.x) / 75, -1, 1);
    const now = this.ctx.currentTime;

    if (this.remote) {
      this.remote.source.playbackRate.setTargetAtTime(0.9 + throttle * 0.17, now, 0.1);
      this.remote.filter.frequency.setTargetAtTime(1200 + throttle * 2300, now, 0.12);
      this.remote.panner.pan.setTargetAtTime(pan, now, 0.1);
      this.remote.gain.gain.setTargetAtTime(otherBoat.engineStalled ? 0 : proximity * (0.035 + throttle * 0.13), now, 0.12);
    }
    if (this.remoteWake) {
      this.remoteWake.source.playbackRate.setTargetAtTime(0.84 + clamp(speed / 18, 0, 1) * 0.19, now, 0.12);
      this.remoteWake.filter.frequency.setTargetAtTime(3500 + clamp(speed / 18, 0, 1) * 3500, now, 0.12);
      this.remoteWake.panner.pan.setTargetAtTime(pan, now, 0.1);
      this.remoteWake.gain.gain.setTargetAtTime(speed < 0.35 ? 0 : proximity * (0.025 + speed / 150), now, 0.12);
    }
  }

  updateWorld(world, playerIndex) {
    if (!world) return;
    const player = world.players?.[playerIndex];
    const boat = player && ["boat", "roof"].includes(player.mode) ? world.boats?.[player.activeBoat] : null;
    const silentBoat = {
      speed: 0,
      throttle: 0,
      water: 0,
      leak: 0,
      engineStalled: true,
      pumpActive: false,
      modelId: "strizh",
    };
    const activeBoat = boat || silentBoat;
    super.update({
      phase: "playing",
      boat: {
        speed: Number(activeBoat.speed) || 0,
        throttle: Number(activeBoat.throttle) || 0,
        water: Number(activeBoat.water) || 0,
        leak: Number(activeBoat.leak) || 0,
        engineStalled: Boolean(activeBoat.engineStalled || activeBoat.sunk || !boat),
        pumpActive: Boolean(activeBoat.pumpActive),
        modelId: "strizh",
      },
      damageControl: {
        floodEmergency: Boolean(activeBoat.emergencyActive),
        floodEmergencyRemaining: Number(activeBoat.emergencyRemaining) || 0,
      },
      navigation: {assistEnabled: false},
    });
    this.updateRemote(world, playerIndex);
  }

  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const mapped = operationEventForFreeEvent(event);
    if (mapped) this.handle([mapped]);

    switch (event.type) {
      case "footstep":
        this.playFootstep({gain: 0.2, rate: 0.92 + Math.random() * 0.16});
        break;
      case "jump":
      case "roof":
        this.playFootstep({gain: 0.28, rate: 1.08});
        if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: 0.17, rate: 1.05, lowpass: 5200});
        break;
      case "swim-step":
        this.play(this.buffers.has("waterSide") ? "waterSide" : "waterSoft", {gain: 0.3, rate: 0.9 + Math.random() * 0.12, lowpass: 6500});
        break;
      case "splash":
      case "sink":
        this.play(this.buffers.has("waterHeavy") ? "waterHeavy" : "waterSoft", {gain: event.type === "sink" ? 0.7 : 0.46, rate: 0.84, lowpass: 7000});
        break;
      case "enter":
      case "exit":
        if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: 0.2, rate: event.type === "enter" ? 1.02 : 0.88, lowpass: 4900});
        break;
      case "shore":
        this.play(this.buffers.has("waterSoft") ? "waterSoft" : "splash", {gain: 0.22, rate: 1.05, lowpass: 6000});
        break;
      default:
        break;
    }
  }

  stopAll() {
    this.stopRemoteLoop("remote");
    this.stopRemoteLoop("remoteWake");
    super.stopAll();
  }
}
