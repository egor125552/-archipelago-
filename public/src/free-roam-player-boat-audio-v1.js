"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=43";
import {spatialGainForDistance} from "./free-roam-audio-v4.js?v=38";
import {relativeMovementPan} from "./free-roam-audio-v3.js?v=38";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

export const PLAYER_BOAT_AUDIO_RANGES = Object.freeze({
  own: 240,
  other: 195,
});

function boatOwnerIndex(boat, fallbackIndex, playerCount) {
  const explicit = Number(boat?.owner);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit < playerCount) return explicit;
  return fallbackIndex < playerCount ? fallbackIndex : null;
}

export function playerBoatAudioSources(world, playerIndex) {
  const listener = world?.players?.[playerIndex];
  if (!listener) return [];
  const occupiedBoatId = ["boat", "roof"].includes(listener.mode) ? listener.activeBoat : null;
  const playerCount = world.players?.length || 0;
  return (world.boats || []).flatMap((boat, fallbackIndex) => {
    const ownerIndex = boatOwnerIndex(boat, fallbackIndex, playerCount);
    if (ownerIndex == null || !boat || boat.sunk || boat.id === occupiedBoatId) return [];
    const isOwn = ownerIndex === playerIndex;
    const maximum = isOwn ? PLAYER_BOAT_AUDIO_RANGES.own : PLAYER_BOAT_AUDIO_RANGES.other;
    const metres = distance(listener, boat);
    if (metres >= maximum) return [];
    const proximity = spatialGainForDistance(metres, maximum);
    const speed = Math.abs(Number(boat.speed) || 0);
    const speedMix = clamp(speed / 18, 0, 1);
    const throttle = clamp(Math.abs(Number(boat.throttle) || 0), 0, 1);
    return [{
      key: String(boat.id ?? fallbackIndex),
      ownerIndex,
      isOwn,
      metres,
      pan: relativeMovementPan(listener, boat),
      engineGain: boat.engineStalled ? 0 : proximity * ((isOwn ? 0.045 : 0.034) + throttle * (isOwn ? 0.17 : 0.14) + speedMix * 0.025),
      wakeGain: speed < 0.25 ? 0 : proximity * (0.014 + speed / 138),
      lowpass: 720 + proximity * 5400 + speedMix * 950,
      engineRate: 0.88 + throttle * 0.17 + speedMix * 0.05,
      wakeRate: 0.83 + speedMix * 0.2,
    }];
  });
}

function createLoop(audio, bufferName, initialLowpass) {
  if (!audio.ctx || !audio.master || !audio.buffers.has(bufferName)) return null;
  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get(bufferName);
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = initialLowpass;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  return {source, filter, panner, gain};
}

function ensureLoops(audio, source) {
  audio.playerBoatLoops ||= new Map();
  let loops = audio.playerBoatLoops.get(source.key);
  if (loops) return loops;
  loops = {
    engine: createLoop(audio, "motorboatReal", 900),
    wake: createLoop(audio, audio.buffers.has("riverWake") ? "riverWake" : "seaReal", 1800),
  };
  audio.playerBoatLoops.set(source.key, loops);
  return loops;
}

function fadeLoops(loops, now) {
  loops?.engine?.gain.gain.setTargetAtTime(0, now, 0.22);
  loops?.wake?.gain.gain.setTargetAtTime(0, now, 0.22);
}

if (!FreeRoamAudio.prototype.__playerBoatSpatialAudioV1) {
  const inheritedStopAll = FreeRoamAudio.prototype.stopAll;

  Object.defineProperty(FreeRoamAudio.prototype, "__playerBoatSpatialAudioV1", {value: true});

  FreeRoamAudio.prototype.updateRemote = function updatePlayerBoatSpatialAudio(world, playerIndex) {
    const sources = playerBoatAudioSources(world, playerIndex);
    this.playerBoatLoops ||= new Map();
    this.spatialDiagnostics ||= {};
    this.spatialDiagnostics.playerBoats = sources.map(source => ({
      boatId: source.key,
      ownerIndex: source.ownerIndex,
      own: source.isOwn,
      metres: source.metres,
      pan: source.pan,
      engineGain: source.engineGain,
      wakeGain: source.wakeGain,
    }));
    const diagnostic = sources.find(source => !source.isOwn) || sources[0];
    this.spatialDiagnostics.remotePan = diagnostic?.pan || 0;
    this.spatialDiagnostics.remoteGain = diagnostic?.engineGain || 0;
    this.spatialDiagnostics.remoteLowpass = diagnostic?.lowpass || 0;

    if (!this.ctx || !this.listenerPoint) return;
    const now = this.ctx.currentTime;
    const activeKeys = new Set();
    for (const source of sources) {
      activeKeys.add(source.key);
      const loops = ensureLoops(this, source);
      if (loops.engine) {
        loops.engine.source.playbackRate.setTargetAtTime(source.engineRate, now, 0.14);
        loops.engine.filter.frequency.setTargetAtTime(source.lowpass, now, 0.2);
        loops.engine.panner.pan.setTargetAtTime(source.pan, now, 0.12);
        loops.engine.gain.gain.setTargetAtTime(source.engineGain, now, 0.22);
      }
      if (loops.wake) {
        loops.wake.source.playbackRate.setTargetAtTime(source.wakeRate, now, 0.16);
        loops.wake.filter.frequency.setTargetAtTime(source.lowpass + 950, now, 0.2);
        loops.wake.panner.pan.setTargetAtTime(source.pan, now, 0.12);
        loops.wake.gain.gain.setTargetAtTime(source.wakeGain, now, 0.22);
      }
    }
    for (const [key, loops] of this.playerBoatLoops) {
      if (!activeKeys.has(key)) fadeLoops(loops, now);
    }
  };

  FreeRoamAudio.prototype.stopAll = function stopPlayerBoatSpatialAudio() {
    for (const loops of this.playerBoatLoops?.values?.() || []) {
      try { loops.engine?.source.stop(); } catch (_) {}
      try { loops.wake?.source.stop(); } catch (_) {}
    }
    this.playerBoatLoops?.clear?.();
    inheritedStopAll.call(this);
  };
}
