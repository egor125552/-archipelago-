"use strict";

import {
  DUAL_TURRET_AUDIO_ROOT,
  DUAL_TURRET_BOAT_TYPE,
} from "./free-roam-dual-turret-config.js?v=4";

export const DUAL_TURRET_AUDIO = Object.freeze({
  engine: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-engine-v1.mp3?v=2`,
  shot: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-shot-v1.mp3?v=2`,
  boarding: `${DUAL_TURRET_AUDIO_ROOT}dual-turret-boarding-v1.mp3?v=1`,
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function relativePan(listener, source) {
  if (!listener || !source) return 0;
  const bearing = Math.atan2((Number(source.x) || 0) - (Number(listener.x) || 0), -((Number(source.y) || 0) - (Number(listener.y) || 0))) * 180 / Math.PI;
  return clamp(Math.sin(wrapDeg(bearing - (Number(listener.heading) || 0)) * Math.PI / 180), -1, 1);
}

function playerAboardBoat(player, boat) {
  return Boolean(
    player
    && boat
    && player.activeBoat === boat.id
    && ["boat", "roof"].includes(player.mode),
  );
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
  const boat = (world?.boats || []).find(candidate => candidate?.boatType === DUAL_TURRET_BOAT_TYPE);
  if (!boat || boat.sunk || boat.reserved || boat.engineStalled) {
    if (audio.dualTurretEngine) audio.dualTurretEngine.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.12);
    return;
  }

  startEngine(audio);
  const engine = audio.dualTurretEngine;
  if (!engine) return;
  const player = world?.players?.[playerIndex] || null;
  const listener = audio.listenerPoint || player;
  const metres = distance(listener, boat);
  const localAboard = playerAboardBoat(player, boat);
  const speed = clamp(Math.abs(Number(boat.speed) || 0) / 13.5, 0, 1);
  const throttle = clamp(Math.abs(Number(boat.throttle) || 0), 0, 1);
  const proximity = localAboard ? 1 : clamp(1 - metres / 230, 0, 1);
  const now = audio.ctx.currentTime;
  engine.source.playbackRate.setTargetAtTime(0.78 + speed * 0.82 + throttle * 0.08, now, 0.11);
  engine.filter.frequency.setTargetAtTime(900 + speed * 4300 + proximity * 700, now, 0.14);
  // When the listener is aboard this exact hull, steering changes the hull's
  // world heading but not the listener-to-engine vessel relationship. Keep the
  // local motor centered, exactly like the ordinary local boat engine. Only a
  // genuinely remote armored patrol is spatialized from world coordinates.
  engine.panner.pan.setTargetAtTime(localAboard ? 0 : relativePan(listener, boat), now, localAboard ? 0.18 : 0.12);
  engine.gain.gain.setTargetAtTime(localAboard ? 0.16 : proximity * 0.13, now, 0.13);
}

export function updateDualTurretProjectileAudio() {}

function isArmoredTransition(event) {
  return ["enter", "exit"].includes(event?.type)
    && (String(event.audioProfile || "").startsWith("dual-turret") || event.boatType === DUAL_TURRET_BOAT_TYPE);
}

export function handleDualTurretAudioEvent(audio, event, playerIndex) {
  if (!event?.targets?.includes(playerIndex)) return false;
  if (isArmoredTransition(event)) {
    const spatial = audio.eventPanAndGain?.(event, 120) || {pan: Number(event.pan) || 0, gain: 1};
    audio.play?.("dualTurretBoarding", {
      pan: spatial.pan,
      gain: (event.type === "exit" ? 0.42 : 0.36) * spatial.gain,
      rate: event.type === "exit" ? 0.86 : 1.02,
      lowpass: 7200,
    });
    return true;
  }
  if (event.type === "dual-turret-shot") {
    const spatial = audio.eventPanAndGain?.(event, 260) || {pan: Number(event.pan) || 0, gain: 1};
    audio.play?.("dualTurretShot", {pan: spatial.pan, gain: 0.34 * spatial.gain, rate: 0.98 + Math.random() * 0.035, lowpass: 9800});
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

export function stopDualTurretAudio(audio) {
  stopEngine(audio);
}
