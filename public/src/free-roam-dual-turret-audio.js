"use strict";

import {DUAL_TURRET_AUDIO_ROOT} from "./free-roam-dual-turret-config.js";

export const DUAL_TURRET_AUDIO = Object.freeze({
  engine: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-engine-v1.mp3?v=1`,
  shot: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-shot-v1.mp3?v=1`,
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function relativePan(listener, source) {
  if (!listener || !source) return 0;
  const bearing = Math.atan2((Number(source.x) || 0) - (Number(listener.x) || 0), -((Number(source.y) || 0) - (Number(listener.y) || 0))) * 180 / Math.PI;
  return clamp(Math.sin(wrapDeg(bearing - (Number(listener.heading) || 0)) * Math.PI / 180), -1, 1);
}

function segmentDistance(point, from, to) {
  const dx = (Number(to?.x) || 0) - (Number(from?.x) || 0);
  const dy = (Number(to?.y) || 0) - (Number(from?.y) || 0);
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return distance(point, to);
  const position = clamp((((Number(point?.x) || 0) - (Number(from?.x) || 0)) * dx
    + ((Number(point?.y) || 0) - (Number(from?.y) || 0)) * dy) / lengthSquared, 0, 1);
  return distance(point, {
    x: (Number(from?.x) || 0) + dx * position,
    y: (Number(from?.y) || 0) + dy * position,
  });
}

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

function stopEngine(audio) {
  const engine = audio?.dualTurretEngine;
  if (!engine) return;
  try { engine.source.stop(); } catch (_) {}
  try { engine.source.disconnect(); } catch (_) {}
  try { engine.filter.disconnect(); } catch (_) {}
  try { engine.panner.disconnect(); } catch (_) {}
  try { engine.gain.disconnect(); } catch (_) {}
  audio.dualTurretEngine = null;
}

function startEngine(audio) {
  if (audio.dualTurretEngine || !audio.ctx || !audio.master || !audio.buffers?.has("dualTurretEngine")) return;
  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get("dualTurretEngine");
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = source.buffer.duration;
  filter.type = "lowpass";
  filter.frequency.value = 1600;
  panner.pan.value = 0;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  audio.dualTurretEngine = {source, filter, panner, gain};
}

export function updateDualTurretEngine(audio, world, playerIndex) {
  if (!audio?.ctx) return;
  const boat = (world?.boats || []).find(candidate => candidate?.boatType === "dual-turret-patrol");
  const occupied = (boat?.crew || []).some(Number.isInteger);
  if (!boat || boat.sunk || boat.reserved || boat.engineStalled || (!occupied && Math.abs(Number(boat.speed) || 0) < 0.15)) {
    if (audio.dualTurretEngine) audio.dualTurretEngine.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.12);
    return;
  }
  startEngine(audio);
  const engine = audio.dualTurretEngine;
  if (!engine) return;
  const listener = audio.listenerPoint || world?.players?.[playerIndex];
  const metres = distance(listener, boat);
  const localAboard = world?.players?.[playerIndex]?.activeBoat === boat.id;
  const speed = clamp(Math.abs(Number(boat.speed) || 0) / 13.5, 0, 1);
  const throttle = clamp(Math.abs(Number(boat.throttle) || 0), 0, 1);
  const proximity = localAboard ? 1 : clamp(1 - metres / 230, 0, 1);
  const now = audio.ctx.currentTime;
  engine.source.playbackRate.setTargetAtTime(0.78 + speed * 0.82 + throttle * 0.08, now, 0.11);
  engine.filter.frequency.setTargetAtTime(900 + speed * 4300 + proximity * 700, now, 0.14);
  engine.panner.pan.setTargetAtTime(localAboard ? 0 : relativePan(listener, boat), now, 0.1);
  engine.gain.gain.setTargetAtTime(localAboard ? 0.16 : proximity * 0.13, now, 0.13);
}


export function updateDualTurretProjectileAudio(audio, world, playerIndex) {
  if (!audio?.ctx) return;
  audio.dualTurretProjectileHeard ||= new Set();
  const replicatedProjectiles = world?.freeDualTurretProjectiles?.projectiles;
  const projectiles = Array.isArray(replicatedProjectiles)
    ? replicatedProjectiles
    : Object.values(replicatedProjectiles || {});
  const active = new Set(projectiles.map(projectile => projectile.id));
  for (const id of [...audio.dualTurretProjectileHeard]) {
    if (!active.has(id)) audio.dualTurretProjectileHeard.delete(id);
  }
  const listener = audio.listenerPoint || world?.players?.[playerIndex];
  if (!listener) return;
  for (const projectile of projectiles) {
    if (!projectile?.id || projectile.sourcePlayer === playerIndex || audio.dualTurretProjectileHeard.has(projectile.id)) continue;
    const previousPoint = {x: projectile.previousX, y: projectile.previousY};
    const passage = segmentDistance(listener, previousPoint, projectile);
    if (passage > 20) continue;
    audio.dualTurretProjectileHeard.add(projectile.id);
    const pan = relativePan(listener, projectile);
    const speed = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
    audio.playSynthPip?.({
      pan,
      frequency: clamp(520 + speed * 4.2, 620, 1100),
      gain: clamp(0.025 + (20 - passage) * 0.004, 0.025, 0.085),
      duration: 0.045,
    });
  }
}

export function handleDualTurretAudioEvent(audio, event, playerIndex) {
  if (!event?.targets?.includes(playerIndex)) return false;
  if (event.type === "dual-turret-shot") {
    const spatial = audio.eventPanAndGain?.(event, 210) || {pan: Number(event.pan) || 0, gain: 1};
    audio.play?.("dualTurretShot", {pan: spatial.pan, gain: 0.34 * spatial.gain, rate: 0.98 + Math.random() * 0.035, lowpass: 9200});
    return true;
  }
  if (event.type === "dual-turret-hit") {
    const spatial = audio.eventPanAndGain?.(event, 180) || {pan: Number(event.pan) || 0, gain: 1};
    if (audio.buffers?.has("gunHit")) audio.play?.("gunHit", {pan: spatial.pan, gain: 0.17 * spatial.gain, rate: 0.9});
    else audio.playSynthPip?.({pan: spatial.pan, frequency: 150, gain: 0.055 * spatial.gain, duration: 0.06});
    return true;
  }
  if (event.type === "dual-turret-projectile-end" && ["water-impact", "ground-impact", "boundary-impact"].includes(event.reason)) {
    const spatial = audio.eventPanAndGain?.(event, 170) || {pan: 0, gain: 1};
    audio.playSynthPip?.({pan: spatial.pan, frequency: event.reason === "water-impact" ? 110 : event.reason === "ground-impact" ? 155 : 190, gain: 0.035 * spatial.gain, duration: 0.045});
    return true;
  }
  return false;
}

export function stopDualTurretAudio(audio) {
  stopEngine(audio);
}
