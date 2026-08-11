"use strict";

import {FreeRoamAudio} from "../free-roam-audio-v5.js?v=45";
import {
  STRESS_TEST_AUDIO_PROFILE,
  STRESS_TEST_ENGINE_LOOP_SECONDS,
  STRESS_TEST_ENGINE_URL,
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_VESSEL_TYPE,
} from "./stress-test-vessel-config.js?v=2";
import {relativeVesselPan} from "./vessel-audio-policy.js?v=1";

const ENGINE_BUFFER = "stress50EngineV2";
const MAX_AUDIBLE_DISTANCE = 320;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function isStressBoat(boat) {
  return Boolean(boat && (boat.boatType === STRESS_TEST_VESSEL_TYPE || boat.vesselType === STRESS_TEST_VESSEL_TYPE));
}

async function preloadStressEngine(audio) {
  if (!audio?.ctx || !audio?.buffers || audio.stress50PreloadPromise) return audio?.stress50PreloadPromise;
  audio.stress50PreloadPromise = (async () => {
    const response = await fetch(STRESS_TEST_ENGINE_URL, {cache: "force-cache"});
    if (!response.ok) throw new Error(`stress50Engine: ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("audio/")) throw new Error(`stress50Engine: unexpected content type ${contentType}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 10_000) throw new Error("stress50Engine: audio file is unexpectedly small");
    audio.buffers.set(ENGINE_BUFFER, await audio.ctx.decodeAudioData(bytes.slice(0)));
  })().catch(error => {
    audio.stress50PreloadPromise = null;
    throw error;
  });
  return audio.stress50PreloadPromise;
}

function engineMap(audio) {
  audio.stress50Engines ||= new Map();
  return audio.stress50Engines;
}

function stopEngineSource(engine) {
  if (!engine) return;
  try { engine.source.stop(); } catch (_) {}
  try { engine.source.disconnect(); } catch (_) {}
  try { engine.filter.disconnect(); } catch (_) {}
  try { engine.panner.disconnect(); } catch (_) {}
  try { engine.gain.disconnect(); } catch (_) {}
}

function startEngine(audio, boat) {
  const sources = engineMap(audio);
  if (sources.has(boat.id) || !audio.ctx || !audio.master || !audio.buffers?.has(ENGINE_BUFFER)) return sources.get(boat.id) || null;
  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get(ENGINE_BUFFER);
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.min(source.buffer.duration, STRESS_TEST_ENGINE_LOOP_SECONDS);
  filter.type = "lowpass";
  filter.frequency.value = 1500;
  panner.pan.value = 0;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  const engine = {source, filter, panner, gain};
  sources.set(boat.id, engine);
  return engine;
}

function updateStressEngines(audio, world, playerIndex) {
  if (!audio?.ctx || !world) return;
  if (!audio.buffers?.has(ENGINE_BUFFER)) preloadStressEngine(audio).catch(() => {});
  const listener = audio.listenerPoint || world.players?.[playerIndex];
  const local = world.players?.[playerIndex];
  const seen = new Set();
  for (const boat of world.boats || []) {
    if (!isStressBoat(boat)) continue;
    seen.add(boat.id);
    const engine = startEngine(audio, boat);
    if (!engine) continue;
    const localAboard = local && ["boat", "roof"].includes(local.mode) && local.activeBoat === boat.id;
    const metres = localAboard ? 0 : distance(listener, boat);
    const audible = !boat.sunk && !boat.reserved && !boat.engineStalled && (localAboard || metres < MAX_AUDIBLE_DISTANCE);
    const proximity = localAboard ? 1 : clamp(1 - metres / MAX_AUDIBLE_DISTANCE, 0, 1);
    const speed = clamp(Math.abs(Number(boat.speed) || 0) / STRESS_TEST_MAX_SPEED, 0, 1);
    const throttle = clamp(Math.abs(Number(boat.throttle) || 0), 0, 1);
    const now = audio.ctx.currentTime;
    engine.source.playbackRate.setTargetAtTime(0.68 + speed * 0.62 + throttle * 0.12, now, 0.1);
    engine.filter.frequency.setTargetAtTime(1200 + speed * 7600 + throttle * 900, now, 0.12);
    engine.panner.pan.setTargetAtTime(localAboard ? 0 : relativeVesselPan(listener, boat), now, 0.08);
    const remoteGain = proximity * proximity * (0.025 + throttle * 0.15 + speed * 0.05);
    engine.gain.gain.setTargetAtTime(audible ? (localAboard ? 0.22 + throttle * 0.045 : remoteGain) : 0, now, 0.1);
  }
  for (const [boatId, engine] of [...engineMap(audio)]) {
    if (seen.has(boatId)) continue;
    stopEngineSource(engine);
    engineMap(audio).delete(boatId);
  }
}

function stopStressEngines(audio) {
  for (const engine of engineMap(audio).values()) stopEngineSource(engine);
  engineMap(audio).clear();
}

function maskStressProfiles(world) {
  const masked = [];
  for (const boat of world?.boats || []) {
    if (!isStressBoat(boat)) continue;
    masked.push([boat, boat.audioProfile]);
    // Compatibility for older cached common-audio clients. New common audio
    // also recognizes the custom vessel profile directly and suppresses its
    // ordinary motor without relying on this temporary mask.
    boat.audioProfile = "dual-turret";
  }
  return () => {
    for (const [boat, profile] of masked) boat.audioProfile = profile || STRESS_TEST_AUDIO_PROFILE;
  };
}

function stressNetworkVessel(world, boat) {
  return (world?.vesselArchitecture?.vessels || []).find(vessel => (
    vessel?.legacyBoatId === boat?.id || vessel?.instanceId === boat?.vesselInstanceId
  )) || null;
}

function updateStressUi(world, playerIndex) {
  if (typeof document === "undefined") return;
  const player = world?.players?.[playerIndex];
  const boat = player && ["boat", "roof"].includes(player.mode) ? world?.boats?.[player.activeBoat] : null;
  if (!isStressBoat(boat)) return;
  const network = stressNetworkVessel(world, boat);
  const operator = network?.interior?.claims?.["stress-pistol-control"];
  if (operator !== playerIndex) return;
  const ammo = Math.max(0, Math.floor(Number(
    network?.modules?.["stress-pistol"]?.ammo
      ?? network?.state?.testWeaponAmmo
      ?? boat.testWeaponAmmo
  ) || 0));
  const weaponValue = document.getElementById("weaponValue");
  const attackButton = document.getElementById("attackButton");
  if (weaponValue) weaponValue.textContent = `сверхскоростной пистолет, ${ammo}`;
  if (attackButton) attackButton.textContent = "Огонь: сверхскоростной пистолет";
}

function handleStressShot(audio, event, playerIndex) {
  if (event?.type !== "vessel-mounted-shot" || event.boatType !== STRESS_TEST_VESSEL_TYPE || !event.targets?.includes(playerIndex)) return false;
  const spatial = audio.eventPanAndGain?.(event, 700) || {pan: 0, gain: 1};
  if (audio.buffers?.has("pistolShot")) {
    if (typeof audio.playExcerpt === "function") {
      audio.playExcerpt("pistolShot", {offset: 0, duration: 0.13, pan: spatial.pan, gain: 0.12 * spatial.gain, rate: 1.18, lowpass: 12500});
    } else {
      audio.play?.("pistolShot", {pan: spatial.pan, gain: 0.08 * spatial.gain, rate: 1.18, lowpass: 12500});
    }
  } else if (audio.buffers?.has("automaticShot")) {
    audio.play?.("automaticShot", {pan: spatial.pan, gain: 0.08 * spatial.gain, rate: 1.28, lowpass: 12000});
  } else {
    audio.playSynthPip?.({pan: spatial.pan, frequency: 1450, gain: 0.045 * spatial.gain, duration: 0.035});
  }
  return true;
}

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__stress50VesselPatchedV4) {
  prototype.__stress50VesselPatchedV4 = true;
  const inheritedPreload = prototype.preload;
  const inheritedUpdateWorld = prototype.updateWorld;
  const inheritedHandleEvent = prototype.handleFreeEvent;
  const inheritedStopAll = prototype.stopAll;

  prototype.preload = async function preloadWithStress50() {
    const inherited = inheritedPreload.call(this);
    const stress = preloadStressEngine(this);
    await Promise.allSettled([inherited, stress]);
  };

  prototype.updateWorld = function updateWorldWithStress50(world, playerIndex) {
    const restore = maskStressProfiles(world);
    let result;
    try {
      result = inheritedUpdateWorld.call(this, world, playerIndex);
    } finally {
      restore();
    }
    updateStressEngines(this, world, playerIndex);
    updateStressUi(world, playerIndex);
    return result;
  };

  prototype.handleFreeEvent = function handleFreeEventWithStress50(event, playerIndex) {
    if (handleStressShot(this, event, playerIndex)) return;
    return inheritedHandleEvent.call(this, event, playerIndex);
  };

  prototype.stopAll = function stopAllWithStress50() {
    stopStressEngines(this);
    return inheritedStopAll.call(this);
  };
}
