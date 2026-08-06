"use strict";

import {DUAL_TURRET_AUDIO_ROOT} from "./free-roam-dual-turret-config.js?v=3";

export const DUAL_TURRET_AUDIO = Object.freeze({
  engine: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-engine-v1.mp3?v=2`,
  shot: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-shot-v1.mp3?v=2`,
});

export async function preloadDualTurretAudio(audio) {
  if (!audio?.ctx || !audio?.buffers) return;
  if (audio.dualTurretPreloadPromise) return audio.dualTurretPreloadPromise;
  audio.dualTurretPreloadPromise = Promise.allSettled(Object.entries(DUAL_TURRET_AUDIO).map(async ([name, url]) => {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    audio.buffers.set(`dualTurret${name[0].toUpperCase()}${name.slice(1)}`, await audio.ctx.decodeAudioData(await response.arrayBuffer()));
  }));
  await audio.dualTurretPreloadPromise;
}

// Compatibility exports only. The shared player-boat audio controller selects
// the one active engine through boat.engineSound.
export function updateDualTurretEngine() {}
export function updateDualTurretProjectileAudio() {}

export function handleDualTurretAudioEvent(audio, event, playerIndex) {
  if (!event?.targets?.includes(playerIndex)) return false;
  if (event.type === "dual-turret-shot") {
    const spatial = audio.eventPanAndGain?.(event, 260) || {pan: Number(event.pan) || 0, gain: 1};
    audio.play?.("dualTurretShot", {pan: spatial.pan, gain: 0.34 * spatial.gain, rate: 0.99, lowpass: 9800});
    return true;
  }
  if (event.type === "dual-turret-hit") {
    const spatial = audio.eventPanAndGain?.(event, 220) || {pan: Number(event.pan) || 0, gain: 1};
    if (audio.buffers?.has("gunHit")) audio.play?.("gunHit", {pan: spatial.pan, gain: 0.2 * spatial.gain, rate: 0.92});
    else audio.playSynthPip?.({pan: spatial.pan, frequency: 150, gain: 0.055 * spatial.gain, duration: 0.06});
    return true;
  }
  return event.type === "dual-turret-projectile-end";
}

export function stopDualTurretAudio() {}
