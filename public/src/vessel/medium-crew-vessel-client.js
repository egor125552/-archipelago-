"use strict";

import {FreeRoamAudio} from "../free-roam-audio-v5.js?v=45";
import {MEDIUM_CREW_VESSEL_TYPE} from "./medium-crew-vessel-config.js?v=1";
import {relativeVesselPan} from "./vessel-audio-policy.js?v=1";

const MEDIUM_ENGINE_TEST_BUFFER = "mediumCrewEngineTest";
const MEDIUM_ENGINE_TEST_URL = "/assets/audio/vessels/medium-crew-engine-test.mp3?v=3";
const MEDIUM_MAX_SPEED = 17.2;
const MAX_AUDIBLE_DISTANCE = 330;
const RETRY_DELAY_MS = 3500;

const OPERATOR_RESOURCES = Object.freeze({
  "medium-pistol-control": Object.freeze({moduleId: "medium-pistol", label: "пистолетная установка"}),
  "medium-heavy-gun-control": Object.freeze({moduleId: "medium-heavy-gun", label: "тяжёлая установка"}),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function isMediumBoat(boat) {
  return Boolean(boat && (
    boat.mediumCrewMarker === true
    || boat.boatType === MEDIUM_CREW_VESSEL_TYPE
    || boat.vesselType === MEDIUM_CREW_VESSEL_TYPE
  ));
}

function mediumBoatForPlayer(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  const boat = world?.boats?.[player.activeBoat] || null;
  return isMediumBoat(boat) ? boat : null;
}

function networkVessel(world, boat) {
  return (world?.vesselArchitecture?.vessels || []).find(vessel => (
    vessel?.legacyBoatId === boat?.id || vessel?.instanceId === boat?.vesselInstanceId
  )) || null;
}

function controlledWeapon(network, playerIndex) {
  for (const [resourceId, descriptor] of Object.entries(OPERATOR_RESOURCES)) {
    if (network?.interior?.claims?.[resourceId] !== playerIndex) continue;
    const ammo = Math.max(0, Math.floor(Number(network?.modules?.[descriptor.moduleId]?.ammo) || 0));
    return {...descriptor, ammo};
  }
  return null;
}

function updateMediumCrewUi(world, playerIndex) {
  if (typeof document === "undefined") return;
  const boat = mediumBoatForPlayer(world, playerIndex);
  if (!boat) return;
  const weapon = controlledWeapon(networkVessel(world, boat), playerIndex);
  if (!weapon) return;
  const weaponValue = document.getElementById("weaponValue");
  const attackButton = document.getElementById("attackButton");
  if (weaponValue) weaponValue.textContent = `${weapon.label}, ${weapon.ammo}`;
  if (attackButton) attackButton.textContent = `Огонь: ${weapon.label}`;
}

async function loadMediumEngine(audio) {
  if (!audio?.ctx || !audio?.buffers) return false;
  if (audio.buffers.has(MEDIUM_ENGINE_TEST_BUFFER)) return true;
  const now = Date.now();
  if (audio.mediumCrewEnginePreloadPromise) return audio.mediumCrewEnginePreloadPromise;
  if (now < (Number(audio.mediumCrewEngineRetryAt) || 0)) return false;

  audio.mediumCrewEnginePreloadPromise = (async () => {
    const response = await fetch(MEDIUM_ENGINE_TEST_URL, {cache: "no-store"});
    if (!response.ok) throw new Error(`medium engine: HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      throw new Error(`medium engine: unexpected content type ${contentType}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error("medium engine: audio file is unexpectedly small");
    const buffer = await audio.ctx.decodeAudioData(bytes.slice(0));
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0.05) throw new Error("medium engine: decoded buffer is empty");
    audio.buffers.set(MEDIUM_ENGINE_TEST_BUFFER, buffer);
    audio.mediumCrewEngineRetryAt = 0;
    return true;
  })().catch(error => {
    audio.mediumCrewEngineRetryAt = Date.now() + RETRY_DELAY_MS;
    audio.mediumCrewEngineLastError = String(error?.message || error || "medium engine load failed");
    return false;
  }).finally(() => {
    audio.mediumCrewEnginePreloadPromise = null;
  });
  return audio.mediumCrewEnginePreloadPromise;
}

function engineMap(audio) {
  audio.mediumCrewEngines ||= new Map();
  return audio.mediumCrewEngines;
}

function stopEngineSource(engine) {
  if (!engine) return;
  try { engine.source.stop(); } catch (_) {}
  for (const node of [engine.source, engine.filter, engine.panner, engine.gain]) {
    try { node.disconnect(); } catch (_) {}
  }
}

function startEngine(audio, boat) {
  const sources = engineMap(audio);
  if (sources.has(boat.id)) return sources.get(boat.id);
  if (!audio?.ctx || !audio?.master || !audio?.buffers?.has(MEDIUM_ENGINE_TEST_BUFFER)) return null;

  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get(MEDIUM_ENGINE_TEST_BUFFER);
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = source.buffer.duration;
  filter.type = "lowpass";
  filter.frequency.value = 4800;
  panner.pan.value = 0;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  const engine = {source, filter, panner, gain};
  sources.set(boat.id, engine);
  return engine;
}

function updateMediumEngines(audio, world, playerIndex) {
  if (!audio?.ctx || !world) return;
  if (!audio.buffers?.has(MEDIUM_ENGINE_TEST_BUFFER)) loadMediumEngine(audio).catch(() => {});
  const listener = audio.listenerPoint || world.players?.[playerIndex];
  const localPlayer = world.players?.[playerIndex];
  const seen = new Set();

  for (const boat of world.boats || []) {
    if (!isMediumBoat(boat)) continue;
    seen.add(boat.id);
    const engine = startEngine(audio, boat);
    if (!engine) continue;

    const localAboard = Boolean(
      localPlayer
      && ["boat", "roof"].includes(localPlayer.mode)
      && localPlayer.activeBoat === boat.id
    );
    const metres = localAboard ? 0 : distance(listener, boat);
    const proximity = localAboard ? 1 : clamp(1 - metres / MAX_AUDIBLE_DISTANCE, 0, 1);
    const speedRatio = clamp(Math.abs(Number(boat.speed) || 0) / MEDIUM_MAX_SPEED, 0, 1);
    const throttle = clamp(Math.abs(Number(boat.throttle) || 0), 0, 1);
    const moduleEngine = networkVessel(world, boat)?.modules?.engine;
    const moduleDisabled = moduleEngine && (moduleEngine.enabled === false || (Number(moduleEngine.health) || 0) <= 0);
    const audible = !boat.sunk && !boat.reserved && !boat.engineStalled && !moduleDisabled
      && (localAboard || metres < MAX_AUDIBLE_DISTANCE);
    const now = audio.ctx.currentTime;

    engine.source.playbackRate.setTargetAtTime(0.84 + speedRatio * 0.23 + throttle * 0.08, now, 0.1);
    engine.filter.frequency.setTargetAtTime(4300 + speedRatio * 2600 + throttle * 700, now, 0.12);
    engine.panner.pan.setTargetAtTime(localAboard ? 0 : relativeVesselPan(listener, boat), now, 0.08);
    const remoteGain = proximity * proximity * (0.035 + throttle * 0.16 + speedRatio * 0.045);
    const targetGain = audible ? (localAboard ? 0.25 + throttle * 0.09 : remoteGain) : 0;
    engine.gain.gain.setTargetAtTime(targetGain, now, 0.11);
  }

  for (const [boatId, engine] of [...engineMap(audio)]) {
    if (seen.has(boatId)) continue;
    stopEngineSource(engine);
    engineMap(audio).delete(boatId);
  }
}

function stopMediumEngines(audio) {
  for (const engine of engineMap(audio).values()) stopEngineSource(engine);
  engineMap(audio).clear();
}

function maskMediumProfiles(world) {
  const masked = [];
  for (const boat of world?.boats || []) {
    if (!isMediumBoat(boat)) continue;
    masked.push([boat, boat.audioProfile]);
    // Compatibility for older cached common-audio clients. New common audio
    // recognizes the custom profile directly and owns legacy suppression.
    boat.audioProfile = "dual-turret";
  }
  return () => {
    for (const [boat, profile] of masked) boat.audioProfile = profile || "medium-crew-v1";
  };
}

function handleMediumShot(audio, event, playerIndex) {
  if (event?.type !== "vessel-mounted-shot" || event.boatType !== MEDIUM_CREW_VESSEL_TYPE || !event.targets?.includes(playerIndex)) return false;
  const spatial = audio.eventPanAndGain?.(event, event.weapon === "dual-turret" ? 420 : 320) || {pan: 0, gain: 1};
  if (event.weapon === "dual-turret" && audio.buffers?.has("dualTurretShot")) {
    audio.play?.("dualTurretShot", {pan: spatial.pan, gain: 0.34 * spatial.gain, rate: 0.98 + Math.random() * 0.035, lowpass: 9800});
    return true;
  }
  if (audio.buffers?.has("pistolShot")) {
    if (typeof audio.playExcerpt === "function") {
      audio.playExcerpt("pistolShot", {offset: 0, duration: 0.13, pan: spatial.pan, gain: 0.12 * spatial.gain, rate: 1.18, lowpass: 12500});
    } else {
      audio.play?.("pistolShot", {pan: spatial.pan, gain: 0.08 * spatial.gain, rate: 1.18, lowpass: 12500});
    }
    return true;
  }
  if (audio.buffers?.has("automaticShot")) {
    audio.play?.("automaticShot", {pan: spatial.pan, gain: 0.1 * spatial.gain, rate: event.weapon === "dual-turret" ? 0.84 : 1.2, lowpass: 10500});
  } else {
    audio.playSynthPip?.({pan: spatial.pan, frequency: event.weapon === "dual-turret" ? 540 : 1450, gain: 0.05 * spatial.gain, duration: 0.045});
  }
  return true;
}

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__mediumCrewVesselPatchedV4) {
  prototype.__mediumCrewVesselPatchedV4 = true;
  const inheritedPreload = prototype.preload;
  const inheritedUpdateWorld = prototype.updateWorld;
  const inheritedHandleEvent = prototype.handleFreeEvent;
  const inheritedStopAll = prototype.stopAll;

  prototype.preload = async function preloadWithMediumCrewEngine() {
    const inherited = inheritedPreload.call(this);
    const medium = loadMediumEngine(this);
    const [baseResult] = await Promise.allSettled([inherited, medium]);
    return baseResult.status === "fulfilled" ? baseResult.value : undefined;
  };

  prototype.updateWorld = function updateWorldWithMediumCrew(world, playerIndex) {
    const restore = maskMediumProfiles(world);
    let result;
    try {
      result = inheritedUpdateWorld.call(this, world, playerIndex);
    } finally {
      restore();
    }
    updateMediumCrewUi(world, playerIndex);
    updateMediumEngines(this, world, playerIndex);
    return result;
  };

  prototype.handleFreeEvent = function handleFreeEventWithMediumCrew(event, playerIndex) {
    if (handleMediumShot(this, event, playerIndex)) return;
    return inheritedHandleEvent.call(this, event, playerIndex);
  };

  prototype.stopAll = function stopAllWithMediumCrew() {
    stopMediumEngines(this);
    return inheritedStopAll.call(this);
  };
}
