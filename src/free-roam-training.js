"use strict";

import {drainEvents, setPlayerInput} from "../public/src/free-roam-core-v6.js";
import {cancelThreatEncounter, startThreatEncounter} from "../public/src/free-roam-threat-director.js?v=3";

export const TRAINING_SAMPLE_MS = 200;
const MAX_TRAINING_FRAMES = 12_000;
const TRAINING_VERSION = 1;

const MODE_CODES = Object.freeze({boat: 1, roof: 2, foot: 3, swim: 4, dead: 5});
const WEAPON_CODES = Object.freeze({fists: 0, knife: 1, pistol: 2, automatic: 3});
const ROLE_CODES = Object.freeze({marauder: 1, escort: 2, rammer: 3, gunboat: 4, landing: 5, interceptor: 6, heavy: 7});
const ACTOR_STATE_CODES = Object.freeze({aboard: 1, disembarking: 2, foot: 3, swim: 4, boarding: 5, dead: 6});

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 3) {
  const number = Number(value) || 0;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function bool(value) {
  return value ? 1 : 0;
}

function presentIndices(world) {
  return (world?.players || [])
    .map((_player, index) => index)
    .filter(index => Boolean(world?.freeActivities?.presence?.[index]));
}

function resetServerInputs(serverRoom) {
  const playerCount = serverRoom?.world?.players?.length || 2;
  serverRoom.inputSequence = Array.from({length: playerCount}, () => 0);
  serverRoom.receivedInputs = Array.from({length: playerCount}, () => ({}));
  serverRoom.pendingPulses = Array.from({length: playerCount}, () => ({}));
  for (let index = 0; index < playerCount; index += 1) setPlayerInput(serverRoom.world, index, {});
}

function readyPlayerForBattle(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return;
  player.combat ||= {};
  const combat = player.combat;
  combat.health = 100;
  combat.alive = true;
  combat.respawnRemaining = 0;
  combat.knockedDown = false;
  combat.knockdownRemaining = 0;
  combat.stun = 0;
  combat.stamina = 100;
  combat.pendingDamage = 0;
  combat.attackCharge = 0;
  combat.attackCooldown = 0;
  combat.injuryMix = 0;
  combat.lockedTargetId = null;
  combat.weapons ||= {};
  combat.weapons.pistol = true;
  combat.weapons.automatic = true;
  combat.pistolAmmo = Math.max(72, Number(combat.pistolAmmo) || 0);
  combat.ammo = Math.max(180, Number(combat.ammo) || 0);
  combat.equipped = "automatic";

  const boat = (world.boats || []).find(candidate => candidate?.owner === playerIndex)
    || world.boats?.[playerIndex]
    || null;
  if (!boat) return;
  boat.sunk = false;
  boat.hull = 100;
  boat.water = 0;
  boat.leak = 0;
  boat.fuel = Math.max(90, Number(boat.fuel) || 0);
  boat.engineTemp = 0;
  boat.engineStalled = false;
  boat.pumpActive = false;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.repairPatches = Math.max(4, Number(boat.repairPatches) || 0);
  boat.cargoPumpBonus = Math.max(2.5, Number(boat.cargoPumpBonus) || 0);
  boat.driver = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}

function prepareExactThreatWorld(sourceWorld, level, presence) {
  const world = cloneValue(sourceWorld);
  world.events ||= [];
  world.tow = null;
  world.freeActivities ||= {};
  world.freeActivities.presence = Array.from({length: world.players?.length || 2}, (_, index) => Boolean(presence[index]));
  world.freeActivities.shopOpen = Array.from({length: world.players?.length || 2}, () => false);
  world.freeActivities.boardOpen = Array.from({length: world.players?.length || 2}, () => false);
  if (world.freeContracts) {
    world.freeContracts.boardOpen = Array.from({length: world.players?.length || 2}, () => false);
    world.freeContracts.encounterActive = false;
    world.freeContracts.encounterLevel = 0;
    world.freeContracts.encounterDefeated = false;
  }
  if (world.freeScenario) {
    world.freeScenario.announced = true;
    world.freeScenario.guideEnabled = Array.from({length: world.players?.length || 2}, () => false);
  }

  cancelThreatEncounter(world, "training-restart");
  for (const playerIndex of presentIndices(world)) readyPlayerForBattle(world, playerIndex);
  drainEvents(world);

  // This is deliberately the production encounter entry point. Training does
  // not own a second enemy table, spawn path, phase system or balance profile.
  startThreatEncounter(world, level, `training-${Date.now().toString(36)}`);
  return world;
}

function inputMask(input) {
  let mask = 0;
  const keys = ["up", "down", "left", "right", "run", "pump", "repair", "action", "jump", "attack", "weapon", "sonar", "guide"];
  for (let index = 0; index < keys.length; index += 1) if (input?.[keys[index]]) mask |= (1 << index);
  return mask;
}

function compactPlayer(world, player, index) {
  const combat = player?.combat || {};
  return [
    index,
    bool(world?.freeActivities?.presence?.[index]),
    bool(combat.alive),
    MODE_CODES[player?.mode] || 0,
    round(player?.x, 2),
    round(player?.y, 2),
    round(player?.heading, 1),
    round(combat.health, 1),
    bool(combat.knockedDown),
    WEAPON_CODES[combat.equipped] || 0,
    Number(combat.ammo) || 0,
    Number(combat.pistolAmmo) || 0,
    combat.lockedTargetId || null,
  ];
}

function compactBoat(boat) {
  return [
    boat?.id ?? null,
    boat?.owner ?? null,
    boat?.driver ?? null,
    round(boat?.x, 2),
    round(boat?.y, 2),
    round(boat?.heading, 1),
    round(boat?.speed, 2),
    round(boat?.hull, 1),
    round(boat?.water, 1),
    round(boat?.leak, 2),
    round(boat?.fuel, 1),
    round(boat?.rudder, 2),
    bool(boat?.sunk),
  ];
}

function compactEnemy(boat, fallbackRole = "") {
  return [
    boat?.id ?? null,
    ROLE_CODES[boat?.role || fallbackRole] || 0,
    round(boat?.x, 2),
    round(boat?.y, 2),
    round(boat?.heading, 1),
    round(boat?.speed, 2),
    round(boat?.hull ?? boat?.health, 1),
    boat?.targetPlayer ?? null,
    bool(boat?.active !== false && !boat?.destroyed),
  ];
}

function compactActor(actor) {
  return [
    actor?.id ?? null,
    actor?.boatId ?? null,
    actor?.targetPlayer ?? null,
    round(actor?.x, 2),
    round(actor?.y, 2),
    round(actor?.heading, 1),
    ACTOR_STATE_CODES[actor?.state] || 0,
    WEAPON_CODES[actor?.weapon] || 0,
    round(actor?.health, 1),
    bool(actor?.elite),
    bool(actor?.active !== false && !actor?.destroyed),
  ];
}

function compactEvent(event) {
  if (!event?.type) return null;
  return {
    type: String(event.type).slice(0, 80),
    at: round(event.at, 3),
    sourcePlayer: Number.isInteger(event.sourcePlayer) ? event.sourcePlayer : null,
    targetPlayer: Number.isInteger(event.targetPlayer) ? event.targetPlayer : null,
    targetBoat: event.targetBoat ?? null,
    actorId: event.actorId ?? event.gunnerId ?? null,
    pursuerId: event.sourcePursuerId ?? event.pursuerId ?? null,
    weapon: event.weapon ?? null,
    damage: Number.isFinite(Number(event.damage)) ? round(event.damage, 2) : null,
    health: Number.isFinite(Number(event.health)) ? round(event.health, 2) : null,
    x: Number.isFinite(Number(event.x)) ? round(event.x, 2) : null,
    y: Number.isFinite(Number(event.y)) ? round(event.y, 2) : null,
  };
}

function captureFrame(serverRoom, runtime, now) {
  const world = serverRoom.world;
  const episode = runtime.episode;
  const threat = world.freeThreatDirector || {};
  const pursuers = [
    world.freeActivities?.marauder,
    ...(world.freePursuerSquad?.escorts || []),
  ].filter(Boolean);
  const frame = {
    t: round((Number(world.time) || 0) - episode.startedWorldTime, 3),
    serverMs: Math.max(0, now - episode.startedAt),
    input: (serverRoom.receivedInputs || []).map(input => [inputMask(input), input?.targetId || null]),
    players: (world.players || []).map((player, index) => compactPlayer(world, player, index)),
    boats: (world.boats || []).map(compactBoat),
    enemies: {
      pursuers: pursuers.map(item => compactEnemy(item, item === world.freeActivities?.marauder ? "marauder" : "escort")),
      boats: (world.freeEnemyBoats?.boats || []).map(item => compactEnemy(item)),
      gunners: (world.freeHostileGunners?.gunners || []).map(compactActor),
      actors: (world.freeHostileActors?.actors || []).map(compactActor),
      heavy: world.freeHeavyPursuer?.boat ? compactEnemy(world.freeHeavyPursuer.boat, "heavy") : null,
    },
    threat: [
      Number(threat.level) || 0,
      bool(threat.active),
      Number(threat.encounterId) || 0,
      Number(world.freeThreatIntelligence?.phase) || 1,
    ],
    events: runtime.pendingEvents.splice(0),
  };
  episode.frames.push(frame);
  if (episode.frames.length >= MAX_TRAINING_FRAMES) {
    episode.truncated = true;
    runtime.recording = false;
  }
}

function beginEpisode(serverRoom, runtime, {mode, level, now, encounterId = 0}) {
  const world = serverRoom.world;
  const id = `${now.toString(36)}-${Math.max(1, Number(runtime.nextEpisodeSerial) || 1).toString(36)}`;
  runtime.nextEpisodeSerial = Math.max(1, Number(runtime.nextEpisodeSerial) || 1) + 1;
  runtime.pendingEvents = [];
  runtime.nextSampleAt = now;
  runtime.episode = {
    version: TRAINING_VERSION,
    id,
    mode,
    level: Number(level) || 0,
    encounterId: Number(encounterId) || 0,
    startedAt: now,
    startedWorldTime: Number(world.time) || 0,
    playerCount: presentIndices(world).length,
    frames: [],
    truncated: false,
  };
  runtime.recording = true;
  return runtime.episode;
}

function finishEpisode(serverRoom, runtime, outcome, now) {
  const episode = runtime.episode;
  if (!episode) return null;
  if (runtime.pendingEvents.length || !episode.frames.length) captureFrame(serverRoom, runtime, now);
  episode.endedAt = now;
  episode.endedWorldTime = Number(serverRoom.world?.time) || episode.startedWorldTime;
  episode.durationSeconds = round(episode.endedWorldTime - episode.startedWorldTime, 3);
  episode.outcome = String(outcome || "unknown");
  episode.frameCount = episode.frames.length;
  runtime.completedEpisodes ||= [];
  runtime.completedEpisodes.push(episode);
  runtime.episode = null;
  runtime.pendingEvents = [];
  runtime.recording = false;
  return episode;
}

function runtimeFor(serverRoom) {
  serverRoom.trainingRuntime ||= {
    active: false,
    battleActive: false,
    captureOrdinary: false,
    originalWorld: null,
    episode: null,
    completedEpisodes: [],
    pendingEvents: [],
    nextEpisodeSerial: 1,
    nextSampleAt: 0,
    level: 0,
    mode: null,
    recording: false,
  };
  const runtime = serverRoom.trainingRuntime;
  runtime.completedEpisodes ||= [];
  runtime.pendingEvents ||= [];
  if (!Number.isFinite(runtime.nextEpisodeSerial)) runtime.nextEpisodeSerial = 1;
  return runtime;
}

export function startServerTrainingBattle(serverRoom, requestedLevel, record = true, now = Date.now()) {
  if (!serverRoom?.world) throw new Error("Free-roam room is unavailable");
  const level = Math.max(2, Math.min(5, Math.floor(Number(requestedLevel) || 2)));
  const runtime = runtimeFor(serverRoom);
  const presence = [...(serverRoom.world.freeActivities?.presence || [true, false])];

  if (runtime.episode) finishEpisode(serverRoom, runtime, "restarted", now);
  if (!runtime.originalWorld) runtime.originalWorld = cloneValue(serverRoom.world);
  const baseWorld = runtime.originalWorld;
  serverRoom.world = prepareExactThreatWorld(baseWorld, level, presence);
  resetServerInputs(serverRoom);
  serverRoom.lastTickAt = now;

  runtime.active = true;
  runtime.battleActive = true;
  runtime.level = level;
  runtime.mode = "quick";
  runtime.startedAt = now;
  runtime.recording = false;
  runtime.pendingEvents = [];
  runtime.nextSampleAt = now;
  if (record) {
    beginEpisode(serverRoom, runtime, {
      mode: "quick",
      level,
      now,
      encounterId: serverRoom.world.freeThreatDirector?.encounterId,
    });
  }

  return trainingRuntimeStatus(serverRoom);
}

export function setServerTrainingRecording(serverRoom, enabled, now = Date.now()) {
  const runtime = runtimeFor(serverRoom);
  runtime.captureOrdinary = Boolean(enabled);
  if (!runtime.captureOrdinary && runtime.episode?.mode === "ordinary") {
    finishEpisode(serverRoom, runtime, "recording-disabled", now);
  }
  return trainingRuntimeStatus(serverRoom);
}

export function finishServerTrainingBattle(serverRoom, outcome = "manual", {restore = true, now = Date.now()} = {}) {
  if (!serverRoom?.world) return trainingRuntimeStatus(serverRoom);
  const runtime = runtimeFor(serverRoom);
  if (runtime.episode) finishEpisode(serverRoom, runtime, outcome, now);
  runtime.battleActive = false;

  if (restore && runtime.originalWorld) {
    const currentPresence = [...(serverRoom.world.freeActivities?.presence || [])];
    const restored = cloneValue(runtime.originalWorld);
    if (restored.freeActivities) {
      restored.freeActivities.presence = Array.from(
        {length: restored.players?.length || currentPresence.length},
        (_, index) => Boolean(currentPresence[index]),
      );
    }
    serverRoom.world = restored;
    resetServerInputs(serverRoom);
    serverRoom.lastTickAt = now;
    serverRoom.world.events ||= [];
    serverRoom.world.events.push({
      type: "training-world-restored",
      text: "Обычный мир восстановлен. Быстрый бой не изменил его прогресс.",
      targets: presentIndices(serverRoom.world),
      at: serverRoom.world.time,
      operationEvent: true,
    });
    runtime.originalWorld = null;
    runtime.active = false;
    runtime.mode = null;
    runtime.level = 0;
  }
  return trainingRuntimeStatus(serverRoom);
}

export function updateTrainingRecorder(serverRoom, now = Date.now(), events = []) {
  if (!serverRoom?.world) return null;
  const runtime = runtimeFor(serverRoom);
  const world = serverRoom.world;
  const director = world.freeThreatDirector || {};

  if (
    runtime.captureOrdinary
    && !runtime.active
    && !runtime.episode
    && director.active
    && Number(director.level) >= 2
  ) {
    runtime.battleActive = true;
    runtime.level = Number(director.level) || 0;
    runtime.mode = "ordinary";
    beginEpisode(serverRoom, runtime, {
      mode: "ordinary",
      level: director.level,
      now,
      encounterId: director.encounterId,
    });
  }

  if (runtime.episode) {
    for (const event of events || []) {
      const compact = compactEvent(event);
      if (compact) runtime.pendingEvents.push(compact);
    }
    if (runtime.recording && now >= runtime.nextSampleAt) {
      captureFrame(serverRoom, runtime, now);
      runtime.nextSampleAt = now + TRAINING_SAMPLE_MS;
    }
  }

  const cleared = (events || []).some(event => event?.type === "contract-threat-cleared")
    || (runtime.battleActive && director.cleared && !director.active);
  if (runtime.battleActive && cleared) {
    if (runtime.episode) finishEpisode(serverRoom, runtime, "victory", now);
    runtime.battleActive = false;
  }
  return trainingRuntimeStatus(serverRoom);
}

export function consumeCompletedTrainingEpisodes(serverRoom) {
  const runtime = serverRoom?.trainingRuntime;
  if (!runtime?.completedEpisodes?.length) return [];
  return runtime.completedEpisodes.splice(0);
}

export function trainingRuntimeStatus(serverRoom) {
  const runtime = serverRoom?.trainingRuntime;
  return {
    trainingActive: Boolean(runtime?.active),
    battleActive: Boolean(runtime?.battleActive),
    mode: runtime?.mode || null,
    level: Number(runtime?.level) || 0,
    recording: Boolean(runtime?.episode),
    ordinaryRecordingEnabled: Boolean(runtime?.captureOrdinary),
    episodeId: runtime?.episode?.id || null,
    frames: runtime?.episode?.frames?.length || 0,
  };
}

export function persistedWorldForServerRoom(serverRoom) {
  const runtime = serverRoom?.trainingRuntime;
  if (runtime?.active && runtime.originalWorld) return runtime.originalWorld;
  return serverRoom?.world || null;
}

export function serializeTrainingEpisode(episode) {
  const header = {
    type: "battle",
    version: episode.version,
    id: episode.id,
    mode: episode.mode,
    level: episode.level,
    encounterId: episode.encounterId,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    durationSeconds: episode.durationSeconds,
    playerCount: episode.playerCount,
    outcome: episode.outcome,
    frameCount: episode.frameCount,
    truncated: Boolean(episode.truncated),
    schema: {
      input: ["buttonMask", "targetId"],
      player: ["index", "present", "alive", "mode", "x", "y", "heading", "health", "knockedDown", "weapon", "ammo", "pistolAmmo", "targetId"],
      boat: ["id", "owner", "driver", "x", "y", "heading", "speed", "hull", "water", "leak", "fuel", "rudder", "sunk"],
      enemy: ["id", "role", "x", "y", "heading", "speed", "health", "targetPlayer", "active"],
      actor: ["id", "boatId", "targetPlayer", "x", "y", "heading", "state", "weapon", "health", "elite", "active"],
    },
  };
  const lines = [JSON.stringify(header)];
  for (const frame of episode.frames || []) lines.push(JSON.stringify({type: "frame", ...frame}));
  lines.push(JSON.stringify({type: "end", id: episode.id, outcome: episode.outcome, frames: episode.frameCount}));
  return `${lines.join("\n")}\n`;
}
