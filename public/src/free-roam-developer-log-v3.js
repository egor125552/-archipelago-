"use strict";

import {
  activeEntitySnapshots,
  collectionValues,
  compactLogValue,
  roundLogNumber,
} from "./free-roam-developer-log-model-v2.js?v=1";
import {
  DEVELOPER_LOG_FORMAT_V3,
  changedTrackSample,
  makeTrackSample,
  stripEventEnvelope,
  summarizeAggregate,
} from "./free-roam-developer-log-format-v3.js?v=1";

const STORAGE_KEY = "echo-free-roam-developer-log-enabled-v1";
const POLL_INTERVAL_MS = 250;
const TRACK_HEARTBEAT_MS = 3000;
const CHECKPOINT_INTERVAL_MS = 10000;
const NETWORK_HEARTBEAT_MS = 2000;
const COMBAT_LOAD_HEARTBEAT_MS = 1000;
const SERVER_STATE_HEARTBEAT_MS = 2000;
const INPUT_PACKET_HEARTBEAT_MS = 2000;
const EVENT_MEMORY_LIMIT = 30000;
const ERROR_REPEAT_WINDOW_MS = 5000;
const MAX_TIMELINE_RECORDS = 120000;
const MAX_TRACK_SAMPLES = 260000;
const MAX_BLACK_BOX_RECORDS = 9000;
const BLACK_BOX_WINDOW_MS = 20000;
const AGGREGATE_BUCKET_MS = 500;
const FOOTSTEP_BUCKET_MS = 2000;
const BOMB_TRACE_INTERVAL_MS = 500;

const ACTIVE_INPUT_KEYS = [
  "up", "down", "left", "right", "run", "pump", "repair", "action", "jump",
  "attack", "weapon", "sonar", "guide", "megaBomb", "respawn",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
  "targetId", "navigationTargetId",
];

const AGGREGATED_EVENTS = new Set([
  "elite-turret-shot",
  "elite-bullet-ended",
  "elite-bullet-flyby",
  "elite-bullet-direct-hit",
  "vessel-mounted-shot",
]);
const COUNTER_EVENTS = new Set([
  "footstep", "swim-step", "hostile-footstep", "hostile-swim-step", "pursuer-aim",
]);
const BLACK_BOX_EVENTS = new Set([
  "mega-bomb-flight",
  ...AGGREGATED_EVENTS,
]);

const state = {
  enabled: readEnabled(),
  startedAt: new Date().toISOString(),
  startedEpochMs: Date.now(),
  startedPerformanceMs: performance.now(),
  sequence: 0,
  timeline: [],
  tracks: new Map(),
  checkpoints: [],
  incidents: [],
  aggregates: new Map(),
  blackBox: [],
  droppedTimeline: 0,
  droppedTrackSamples: 0,
  timer: 0,
  lastCheckpointAt: -Infinity,
  lastInput: null,
  lastNetwork: null,
  lastNetworkAt: 0,
  lastPhaseSummary: "",
  lastCombatLoad: "",
  lastCombatLoadAt: 0,
  lastServerState: null,
  lastServerStateAt: 0,
  lastPacketInput: null,
  lastInputPacketAt: 0,
  entitySnapshots: new Map(),
  entityLoggedAt: new Map(),
  seenEventIds: new Set(),
  seenEventQueue: [],
  lastMessage: "",
  lastErrorKey: "",
  lastErrorAt: 0,
  repeatedErrors: 0,
  lastBombTraceAt: new Map(),
  keyboardRepeats: new Map(),
  roomId: null,
  playerIndex: null,
};

const $ = id => document.getElementById(id);
function readEnabled() { try { return localStorage.getItem(STORAGE_KEY) === "on"; } catch (_) { return false; } }
function saveEnabled() { try { localStorage.setItem(STORAGE_KEY, state.enabled ? "on" : "off"); } catch (_) {} }
function api() { return globalThis.__freeRoam || null; }
function currentWorld() { try { return api()?.getWorld?.() || null; } catch (_) { return null; } }
function elapsedMs() { return Math.max(0, Math.round(performance.now() - state.startedPerformanceMs)); }
function currentWorldTime() { return roundLogNumber(currentWorld()?.time, 3); }

function refreshContext() {
  const game = api();
  let roomId = null;
  let playerIndex = null;
  try { roomId = game?.roomId?.() || null; } catch (_) {}
  try { playerIndex = game?.playerIndex?.() ?? null; } catch (_) {}
  if (roomId !== state.roomId || playerIndex !== state.playerIndex) {
    state.roomId = roomId;
    state.playerIndex = playerIndex;
    appendTimeline("context", {roomId, playerIndex});
  }
}

function trimTimeline() {
  if (state.timeline.length <= MAX_TIMELINE_RECORDS) return;
  const remove = Math.min(2000, state.timeline.length - MAX_TIMELINE_RECORDS);
  state.timeline.splice(0, remove);
  state.droppedTimeline += remove;
}

function appendTimeline(kind, details = {}, options = {}) {
  if (!state.enabled && !options.force) return;
  const record = [
    elapsedMs(),
    currentWorldTime(),
    ++state.sequence,
    kind,
    compactLogValue(details),
  ];
  state.timeline.push(record);
  trimTimeline();
  if (options.blackBox) appendBlackBox(kind, details, record[0]);
  updateStatus();
  return record;
}

function appendBlackBox(kind, details, timeMs = elapsedMs()) {
  state.blackBox.push([timeMs, kind, compactLogValue(details)]);
  const cutoff = timeMs - BLACK_BOX_WINDOW_MS;
  while (state.blackBox.length && (state.blackBox[0][0] < cutoff || state.blackBox.length > MAX_BLACK_BOX_RECORDS)) {
    state.blackBox.shift();
  }
}

function freezeBlackBox(reason, details = {}) {
  if (!state.blackBox.length) return;
  state.incidents.push({
    atMs: elapsedMs(),
    worldTime: currentWorldTime(),
    reason,
    details: compactLogValue(details),
    records: state.blackBox.map(record => [...record]),
  });
}

function appendError(error, kind = "logger-error") {
  const message = error?.message || String(error);
  const stack = error?.stack || null;
  const key = `${message}\n${stack || ""}`;
  const now = performance.now();
  if (key === state.lastErrorKey && now - state.lastErrorAt < ERROR_REPEAT_WINDOW_MS) {
    state.repeatedErrors += 1;
    return;
  }
  flushRepeatedErrors();
  state.lastErrorKey = key;
  state.lastErrorAt = now;
  freezeBlackBox(kind, {message});
  appendTimeline(kind, {message, stack});
}

function flushRepeatedErrors() {
  if (state.repeatedErrors <= 0) return;
  appendTimeline("logger-error-repeat", {
    message: state.lastErrorKey.split("\n")[0],
    repeated: state.repeatedErrors,
  });
  state.repeatedErrors = 0;
}

function eventIdentity(event, occurrence = 1) {
  return [roundLogNumber(event?.at, 3), event?.type || "unknown", event?.sourcePlayer ?? "",
    event?.targetPlayer ?? "", event?.targetId ?? "", event?.component ?? "",
    roundLogNumber(event?.x), roundLogNumber(event?.y), event?.text || "", occurrence].join("|");
}
function rememberEvent(id) {
  if (state.seenEventIds.has(id)) return false;
  state.seenEventIds.add(id);
  state.seenEventQueue.push(id);
  while (state.seenEventQueue.length > EVENT_MEMORY_LIMIT) state.seenEventIds.delete(state.seenEventQueue.shift());
  return true;
}

function aggregateKey(event, bucketMs) {
  const bucket = Math.floor(elapsedMs() / bucketMs);
  return [bucket, event?.type, event?.turretId, event?.weapon, event?.reason,
    event?.sourcePlayer, event?.targetPlayer, event?.targetId, event?.boatId, event?.moduleId].join("|");
}

function addAggregate(event, bucketMs = AGGREGATE_BUCKET_MS) {
  const key = aggregateKey(event, bucketMs);
  let aggregate = state.aggregates.get(key);
  if (!aggregate) {
    aggregate = {
      bucketStartMs: Math.floor(elapsedMs() / bucketMs) * bucketMs,
      bucketMs,
      type: event?.type || "unknown",
      firstAt: roundLogNumber(event?.at, 3),
      lastAt: roundLogNumber(event?.at, 3),
      count: 0,
      damage: 0,
      firstProjectileId: event?.projectileId || null,
      lastProjectileId: event?.projectileId || null,
      turretId: event?.turretId || null,
      weapon: event?.weapon || null,
      reason: event?.reason || null,
      sourcePlayer: Number.isInteger(event?.sourcePlayer) ? event.sourcePlayer : null,
      targetPlayer: Number.isInteger(event?.targetPlayer) ? event.targetPlayer : null,
      targetId: event?.targetId || null,
      firstX: roundLogNumber(event?.x),
      firstY: roundLogNumber(event?.y),
      lastX: roundLogNumber(event?.x),
      lastY: roundLogNumber(event?.y),
      hits: 0,
      misses: 0,
    };
    state.aggregates.set(key, aggregate);
  }
  aggregate.count += 1;
  aggregate.lastAt = roundLogNumber(event?.at, 3);
  aggregate.lastProjectileId = event?.projectileId || aggregate.lastProjectileId;
  aggregate.lastX = roundLogNumber(event?.x);
  aggregate.lastY = roundLogNumber(event?.y);
  if (Number.isFinite(Number(event?.damage))) aggregate.damage = roundLogNumber(aggregate.damage + Number(event.damage), 3);
  if (event?.hit === true || event?.applied === true) aggregate.hits += 1;
  if (event?.hit === false || event?.applied === false) aggregate.misses += 1;
}

function flushAggregates(force = false) {
  const now = elapsedMs();
  for (const [key, aggregate] of [...state.aggregates.entries()]) {
    if (!force && now < aggregate.bucketStartMs + aggregate.bucketMs + 50) continue;
    state.timeline.push([
      aggregate.bucketStartMs,
      aggregate.lastAt,
      ++state.sequence,
      "event-aggregate",
      summarizeAggregate(aggregate),
    ]);
    state.aggregates.delete(key);
  }
  trimTimeline();
}

function compactBombTrace(event) {
  return {
    projectileId: event?.projectileId || event?.id || null,
    at: roundLogNumber(event?.at, 3),
    x: roundLogNumber(event?.x), y: roundLogNumber(event?.y), z: roundLogNumber(event?.z),
    vx: roundLogNumber(event?.vx), vy: roundLogNumber(event?.vy), vz: roundLogNumber(event?.vz),
    heading: roundLogNumber(event?.heading), age: roundLogNumber(event?.age),
    energy: roundLogNumber(event?.energy), bounces: event?.bounces ?? 0,
    armed: event?.armed === true, surface: event?.surface || null,
    targetX: roundLogNumber(event?.targetX), targetY: roundLogNumber(event?.targetY),
    targetPlayer: Number.isInteger(event?.targetPlayer) ? event.targetPlayer : null,
    sourceBoatId: event?.sourceBoatId || null,
    sourceActorId: event?.sourceActorId || null,
    tacticalRole: event?.tacticalRole || null,
  };
}

function captureMegaBombFlight(event) {
  const projectileId = event?.projectileId || event?.id || "unknown";
  const now = elapsedMs();
  const previous = state.lastBombTraceAt.get(projectileId) ?? -Infinity;
  const important = event?.armed === true || Number(event?.bounces) > 0 || now - previous >= BOMB_TRACE_INTERVAL_MS;
  appendBlackBox("mega-bomb-flight", {event: compactLogValue(event)}, now);
  if (!important) return;
  state.lastBombTraceAt.set(projectileId, now);
  appendTimeline("bomb-trace", compactBombTrace(event));
}

function captureServerEvents(events) {
  const occurrence = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const base = eventIdentity(event, 0);
    const count = (occurrence.get(base) || 0) + 1;
    occurrence.set(base, count);
    if (!rememberEvent(eventIdentity(event, count))) continue;
    const type = event?.type || "unknown";

    if (type === "mega-bomb-flight") {
      captureMegaBombFlight(event);
      continue;
    }
    if (COUNTER_EVENTS.has(type)) {
      addAggregate(event, FOOTSTEP_BUCKET_MS);
      continue;
    }
    if (AGGREGATED_EVENTS.has(type)) {
      appendBlackBox(type, {event: compactLogValue(event)});
      addAggregate(event);
      continue;
    }
    appendTimeline("game-event", {
      type,
      at: roundLogNumber(event?.at, 3),
      data: stripEventEnvelope(event),
    });
  }
}

function captureSocketMessage(raw) {
  if (!state.enabled || typeof raw !== "string") return;
  let message;
  try { message = JSON.parse(raw); } catch (_) { return; }
  if (Array.isArray(message.events)) captureServerEvents(message.events);
  if (message.type === "free-state" || message.world || message.worldDelta) {
    const now = performance.now();
    const snapshot = {
      type: message.type || null,
      sequence: message.sequence ?? null,
      serverAt: message.serverAt ?? null,
      ackInput: message.ackInput ?? null,
      fullWorld: Boolean(message.world),
      deltaKeys: message.worldDelta && typeof message.worldDelta === "object" ? Object.keys(message.worldDelta) : [],
      eventCount: Array.isArray(message.events) ? message.events.length : 0,
    };
    const previousSequence = Number(state.lastServerState?.sequence);
    const nextSequence = Number(snapshot.sequence);
    const sequenceGap = Number.isFinite(previousSequence) && Number.isFinite(nextSequence) && nextSequence > previousSequence + 1;
    const important = snapshot.fullWorld || sequenceGap || now - state.lastServerStateAt >= SERVER_STATE_HEARTBEAT_MS;
    if (sequenceGap) freezeBlackBox("server-sequence-gap", {previousSequence, nextSequence});
    if (important) {
      appendTimeline("server-state", {
        ...snapshot,
        compressedTicks: state.lastServerState && Number.isFinite(nextSequence) && Number.isFinite(previousSequence)
          ? Math.max(0, nextSequence - previousSequence - 1) : 0,
      });
      state.lastServerStateAt = now;
    }
    state.lastServerState = compactLogValue(snapshot);
  } else if (!["free-pong", "heartbeat"].includes(message.type)) {
    appendTimeline("server-message", {
      type: message.type || null,
      room: message.room || null,
      role: message.role || null,
      matched: message.matched ?? null,
    });
  }
}

function captureSocketSend(raw) {
  if (!state.enabled || typeof raw !== "string") return;
  let message;
  try { message = JSON.parse(raw); } catch (_) { return; }
  if (message.type === "free-input") {
    const now = performance.now();
    const input = compactLogValue(message.input || null);
    const changed = JSON.stringify(input) !== JSON.stringify(state.lastPacketInput);
    if (changed || now - state.lastInputPacketAt >= INPUT_PACKET_HEARTBEAT_MS) {
      appendTimeline("client-input-packet", {sequence: message.sequence ?? null, input, heartbeat: !changed});
      state.lastInputPacketAt = now;
    }
    state.lastPacketInput = input;
  } else if (!["heartbeat", "free-ping"].includes(message.type)) {
    appendTimeline("client-message", {type: message.type || null});
  }
}

function installWebSocketTap() {
  const NativeWebSocket = globalThis.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__archipelagoDeveloperLogV3) return;
  class LoggedWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      super.addEventListener("message", event => {
        try {
          if (typeof event.data === "string") captureSocketMessage(event.data);
          else if (event.data instanceof Blob) event.data.text().then(captureSocketMessage).catch(() => {});
        } catch (error) { appendError(error); }
      });
    }
    send(data) {
      try { captureSocketSend(data); } catch (error) { appendError(error); }
      return super.send(data);
    }
  }
  Object.defineProperty(LoggedWebSocket, "__archipelagoDeveloperLogV3", {value: true});
  globalThis.WebSocket = LoggedWebSocket;
}

function sanitizeTrackSnapshot(snapshot) {
  const result = {...snapshot};
  delete result.bombCooldown;
  delete result.salvoRemaining;
  delete result.bulletCount;
  delete result.pendingBombCount;
  if (Array.isArray(result.turrets)) {
    result.turrets = result.turrets.map(turret => ({
      id: turret.id,
      side: turret.side,
      hp: turret.hp,
      state: turret.state,
      destroyed: turret.destroyed === true,
      targetPlayer: turret.targetPlayer ?? null,
    }));
  }
  return result;
}

function trackSnapshot(rawSnapshot, nowMs, force = false) {
  const snapshot = sanitizeTrackSnapshot(rawSnapshot);
  const key = snapshot.key;
  const previous = state.entitySnapshots.get(key) || null;
  const lastAt = state.entityLoggedAt.get(key) ?? -Infinity;
  const heartbeat = nowMs - lastAt >= TRACK_HEARTBEAT_MS;
  if (!force && !heartbeat && !changedTrackSample(previous, snapshot)) return;

  let track = state.tracks.get(key);
  if (!track) {
    track = {kind: snapshot.kind, id: snapshot.id, samples: []};
    state.tracks.set(key, track);
  }
  track.samples.push(makeTrackSample(nowMs, previous, snapshot));
  state.entitySnapshots.set(key, compactLogValue(snapshot));
  state.entityLoggedAt.set(key, nowMs);
}

function trimTracksIfNeeded() {
  let count = 0;
  for (const track of state.tracks.values()) count += track.samples.length;
  if (count <= MAX_TRACK_SAMPLES) return;
  const targetRemove = Math.min(5000, count - MAX_TRACK_SAMPLES);
  let removed = 0;
  const tracks = [...state.tracks.values()].sort((left, right) => right.samples.length - left.samples.length);
  for (const track of tracks) {
    while (track.samples.length > 1 && removed < targetRemove) {
      track.samples.shift();
      removed += 1;
    }
    if (removed >= targetRemove) break;
  }
  state.droppedTrackSamples += removed;
}

function scanEntities(world) {
  const nowMs = elapsedMs();
  const liveKeys = new Set();
  for (const snapshot of activeEntitySnapshots(world)) {
    liveKeys.add(snapshot.key);
    const existed = state.entitySnapshots.has(snapshot.key);
    trackSnapshot(snapshot, nowMs);
    if (!existed) appendTimeline("entity-spawned", {key: snapshot.key, kind: snapshot.kind, id: snapshot.id});
  }
  for (const [key, previous] of [...state.entitySnapshots.entries()]) {
    if (liveKeys.has(key)) continue;
    appendTimeline("entity-removed", {
      key,
      kind: previous.kind,
      id: previous.id,
      last: previous,
      reason: previous.kind?.startsWith("enemy") || previous.kind === "heavy-boat" ? "destroyed-or-inactive" : "removed-or-sunk",
    });
    state.entitySnapshots.delete(key);
    state.entityLoggedAt.delete(key);
  }
  trimTracksIfNeeded();
}

function scanInput() {
  const input = api()?.input;
  if (!input) return;
  const current = Object.fromEntries(ACTIVE_INPUT_KEYS.map(key => [key, input[key] ?? null]));
  if (!state.lastInput) {
    state.lastInput = current;
    appendTimeline("input-state", {changes: current, initial: true});
    return;
  }
  const changes = {};
  for (const key of ACTIVE_INPUT_KEYS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(state.lastInput[key])) changes[key] = current[key];
  }
  if (Object.keys(changes).length) appendTimeline("input-state", {changes});
  state.lastInput = current;
}

function networkSnapshot() { try { return api()?.networkDiagnostics?.() || null; } catch (_) { return null; } }
function scanNetwork() {
  const current = networkSnapshot();
  if (!current) return;
  const now = performance.now();
  const importantChange = !state.lastNetwork
    || current.reconnecting !== state.lastNetwork.reconnecting
    || current.reconnectAttempt !== state.lastNetwork.reconnectAttempt
    || Math.abs((Number(current.controlLatencyMs) || 0) - (Number(state.lastNetwork.controlLatencyMs) || 0)) >= 120
    || Math.abs((Number(current.networkRttMs) || 0) - (Number(state.lastNetwork.networkRttMs) || 0)) >= 80;
  if (importantChange || now - state.lastNetworkAt >= NETWORK_HEARTBEAT_MS) {
    appendTimeline("network-state", {network: current});
    state.lastNetworkAt = now;
  }
  state.lastNetwork = compactLogValue(current);
}

function projectileCount(value) { return collectionValues(value).length; }
function phaseSummary(world) {
  return {
    scenarioPhase: world.freeScenario?.phase || null,
    contractId: world.freeContracts?.activeContract?.id || null,
    contractPhase: world.freeContracts?.activeContract?.phase || null,
    encounterActive: world.freeContracts?.encounterActive === true,
    threatLevel: world.freeThreatDirector?.level ?? null,
    threatEncounterId: world.freeThreatDirector?.encounterId ?? null,
    elite: {
      phase: world.freeEliteBoatBoss?.phase || null,
      stage: world.freeEliteBoatBoss?.stage || null,
      movementMode: world.freeEliteBoatBoss?.boat?.movementMode || null,
      bombBayState: world.freeEliteBoatBoss?.bombBayState || null,
      commanderId: world.freeEliteBoatBoss?.commanderId || null,
      tacticsVersion: world.freeEliteBossTacticsV12?.version || null,
    },
  };
}
function combatLoad(world) {
  return {
    projectiles: {
      pursuer: projectileCount(world.freePursuerSquad?.projectiles),
      enemyBoats: projectileCount(world.freeEnemyBoats?.projectiles),
      hostileGunners: projectileCount(world.freeHostileGunners?.projectiles),
      hostileActors: projectileCount(world.freeHostileActors?.projectiles),
      heavy: projectileCount(world.freeHeavyPursuer?.projectiles),
      megaBombs: projectileCount(world.freeMegaBombs?.projectiles),
      eliteBullets: projectileCount(world.freeEliteBoatBoss?.projectiles),
      pendingEliteBombs: projectileCount(world.freeEliteBoatBoss?.bombRequests),
    },
  };
}
function scanWorldSummary(world) {
  const phase = phaseSummary(world);
  const serializedPhase = JSON.stringify(phase);
  if (serializedPhase !== state.lastPhaseSummary) {
    state.lastPhaseSummary = serializedPhase;
    appendTimeline("phase-summary", {summary: phase});
  }
  const load = combatLoad(world);
  const serializedLoad = JSON.stringify(load);
  const nowMs = elapsedMs();
  if (serializedLoad !== state.lastCombatLoad && nowMs - state.lastCombatLoadAt >= COMBAT_LOAD_HEARTBEAT_MS) {
    state.lastCombatLoad = serializedLoad;
    state.lastCombatLoadAt = nowMs;
    appendTimeline("combat-load", {summary: load});
  }
}

function makeCheckpoint(world, force = false) {
  const nowMs = elapsedMs();
  if (!force && nowMs - state.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
  const entities = activeEntitySnapshots(world).map(snapshot => compactLogValue(snapshot));
  state.checkpoints.push({
    atMs: nowMs,
    worldTime: roundLogNumber(world?.time, 3),
    phase: phaseSummary(world),
    combatLoad: combatLoad(world),
    input: compactLogValue(state.lastInput),
    network: compactLogValue(state.lastNetwork),
    entities,
  });
  state.lastCheckpointAt = nowMs;
}

function poll() {
  if (!state.enabled) return;
  try {
    refreshContext();
    flushAggregates();
    flushKeyboardRepeats();
    scanInput();
    scanNetwork();
    const world = currentWorld();
    if (!world) return;
    scanEntities(world);
    scanWorldSummary(world);
    makeCheckpoint(world);
  } catch (error) {
    appendError(error);
  }
}

function resetSession() {
  state.startedAt = new Date().toISOString();
  state.startedEpochMs = Date.now();
  state.startedPerformanceMs = performance.now();
  state.sequence = 0;
  state.timeline = [];
  state.tracks = new Map();
  state.checkpoints = [];
  state.incidents = [];
  state.aggregates = new Map();
  state.blackBox = [];
  state.droppedTimeline = 0;
  state.droppedTrackSamples = 0;
  state.lastCheckpointAt = -Infinity;
  state.lastInput = null;
  state.lastNetwork = null;
  state.lastNetworkAt = 0;
  state.lastPhaseSummary = "";
  state.lastCombatLoad = "";
  state.lastCombatLoadAt = 0;
  state.lastServerState = null;
  state.lastServerStateAt = 0;
  state.lastPacketInput = null;
  state.lastInputPacketAt = 0;
  state.entitySnapshots = new Map();
  state.entityLoggedAt = new Map();
  state.seenEventIds = new Set();
  state.seenEventQueue = [];
  state.lastMessage = "";
  state.lastErrorKey = "";
  state.lastErrorAt = 0;
  state.repeatedErrors = 0;
  state.lastBombTraceAt = new Map();
  state.keyboardRepeats = new Map();
  state.roomId = null;
  state.playerIndex = null;
  updateStatus();
}

function setEnabled(enabled) {
  const desired = Boolean(enabled);
  if (state.enabled === desired) return;
  state.enabled = desired;
  saveEnabled();
  if (desired) {
    resetSession();
    appendTimeline("logger-enabled", {
      format: DEVELOPER_LOG_FORMAT_V3,
      userAgent: navigator.userAgent,
      language: navigator.language,
      url: location.href,
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    }, {force: true});
    poll();
  } else {
    flushAggregates(true);
    flushKeyboardRepeats(true);
    flushRepeatedErrors();
    appendTimeline("logger-disabled", {}, {force: true});
  }
  syncControls();
}

function fileStem() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let room = "menu";
  try { room = api()?.roomId?.() || room; } catch (_) {}
  return `Архипелаг — журнал ${room} — ${stamp}`;
}

function serializableTracks() {
  return Object.fromEntries([...state.tracks.entries()].map(([key, track]) => [key, track]));
}
function buildPayload() {
  flushAggregates(true);
  flushKeyboardRepeats(true);
  flushRepeatedErrors();
  const world = currentWorld();
  if (world) makeCheckpoint(world, true);
  const orderedTimeline = [...state.timeline].sort((left, right) => (left[0] - right[0]) || (left[2] - right[2]));
  return {
    format: DEVELOPER_LOG_FORMAT_V3,
    schema: {
      timeline: "[elapsedMs, worldTime, sequence, kind, payload]",
      trackSample: "[elapsedMs, fieldIndex, value, fieldIndex, value, ...]",
      trackFieldsModule: "free-roam-developer-log-format-v3.js",
      aggregate: "[type, firstAt, lastAt, count, damage, firstProjectileId, lastProjectileId, turretId, weapon, reason, sourcePlayer, targetPlayer, targetId, firstX, firstY, lastX, lastY, hits, misses]",
      checkpoints: "full reconstruction snapshots every 10 seconds",
      incidents: "20-second raw black-box window frozen on JavaScript/logger errors and server sequence gaps",
    },
    startedAt: state.startedAt,
    exportedAt: new Date().toISOString(),
    enabled: state.enabled,
    roomId: state.roomId,
    playerIndex: state.playerIndex,
    droppedTimeline: state.droppedTimeline,
    droppedTrackSamples: state.droppedTrackSamples,
    timelineCount: state.timeline.length,
    trackSampleCount: [...state.tracks.values()].reduce((sum, track) => sum + track.samples.length, 0),
    checkpointCount: state.checkpoints.length,
    incidentCount: state.incidents.length,
    timeline: orderedTimeline,
    tracks: serializableTracks(),
    checkpoints: state.checkpoints,
    incidents: state.incidents,
  };
}

async function gzipBlob(text) {
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  return new Blob([bytes], {type: "application/gzip"});
}

async function download() {
  const payload = buildPayload();
  const text = JSON.stringify(payload);
  let blob = null;
  let extension = ".archlog";
  try {
    blob = await gzipBlob(text);
    if (blob) extension = ".archlog.gz";
  } catch (error) {
    appendError(error, "logger-compression-error");
  }
  if (!blob) blob = new Blob([text], {type: "application/json;charset=utf-8"});

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileStem()}${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  appendTimeline("log-downloaded", {
    timelineCount: state.timeline.length,
    trackSampleCount: payload.trackSampleCount,
    checkpointCount: payload.checkpointCount,
    incidentCount: payload.incidentCount,
    bytes: blob.size,
    compressed: extension.endsWith(".gz"),
  });
}

function targetDescription(target) {
  if (!(target instanceof Element)) return {tag: null};
  return {
    tag: target.tagName.toLowerCase(),
    id: target.id || null,
    role: target.getAttribute("role"),
    ariaLabel: target.getAttribute("aria-label"),
    text: String(target.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160) || null,
  };
}

function noteKeyboardRepeat(event) {
  const bucket = Math.floor(elapsedMs() / FOOTSTEP_BUCKET_MS);
  const key = `${bucket}|${event.code}`;
  const value = state.keyboardRepeats.get(key) || {bucket, code: event.code, count: 0};
  value.count += 1;
  state.keyboardRepeats.set(key, value);
}
function flushKeyboardRepeats(force = false) {
  const currentBucket = Math.floor(elapsedMs() / FOOTSTEP_BUCKET_MS);
  for (const [key, value] of [...state.keyboardRepeats.entries()]) {
    if (!force && value.bucket >= currentBucket) continue;
    state.timeline.push([
      value.bucket * FOOTSTEP_BUCKET_MS,
      currentWorldTime(),
      ++state.sequence,
      "keyboard-repeat-summary",
      [value.code, value.count],
    ]);
    state.keyboardRepeats.delete(key);
  }
  trimTimeline();
}

function bindBrowserEvents() {
  window.addEventListener("keydown", event => {
    if (!state.enabled) return;
    if (event.repeat) {
      noteKeyboardRepeat(event);
      return;
    }
    appendTimeline("keyboard", {action: "down", code: event.code, key: event.key, target: targetDescription(event.target)});
  }, true);
  window.addEventListener("keyup", event => {
    if (!state.enabled) return;
    appendTimeline("keyboard", {action: "up", code: event.code, key: event.key, target: targetDescription(event.target)});
  }, true);
  for (const name of ["pointerdown", "pointerup", "click"]) document.addEventListener(name, event => {
    if (!state.enabled) return;
    appendTimeline("pointer", {
      action: name,
      pointerType: event.pointerType || null,
      pointerId: event.pointerId ?? null,
      button: event.button ?? null,
      buttons: event.buttons ?? null,
      clientX: roundLogNumber(event.clientX, 0),
      clientY: roundLogNumber(event.clientY, 0),
      target: targetDescription(event.target),
    });
  }, true);
  document.addEventListener("visibilitychange", () => appendTimeline("page-visibility", {hidden: document.hidden}));
  window.addEventListener("online", () => appendTimeline("browser-network", {online: true}));
  window.addEventListener("offline", () => appendTimeline("browser-network", {online: false}));
  window.addEventListener("focus", () => appendTimeline("window-focus", {focused: true}));
  window.addEventListener("blur", () => appendTimeline("window-focus", {focused: false}));
  window.addEventListener("error", event => {
    freezeBlackBox("javascript-error", {message: event.message, filename: event.filename, line: event.lineno, column: event.colno});
    appendTimeline("javascript-error", {message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack || null});
  });
  window.addEventListener("unhandledrejection", event => {
    const reason = event.reason?.stack || event.reason?.message || String(event.reason);
    freezeBlackBox("promise-rejection", {reason});
    appendTimeline("promise-rejection", {reason});
  });
  const message = $("message");
  if (message) new MutationObserver(() => {
    const text = String(message.textContent || "").trim();
    if (!state.enabled || !text || text === state.lastMessage) return;
    state.lastMessage = text;
    appendTimeline("ui-message", {text});
  }).observe(message, {childList: true, characterData: true, subtree: true});
}

function updateStatus() {
  const output = $("settingsDeveloperLogStatus");
  if (!output) return;
  const trackCount = [...state.tracks.values()].reduce((sum, track) => sum + track.samples.length, 0);
  const dropped = state.droppedTimeline + state.droppedTrackSamples;
  output.textContent = state.timeline.length || trackCount
    ? `Событий: ${state.timeline.length}. Точек движения: ${trackCount}. Контрольных точек: ${state.checkpoints.length}.${dropped ? ` Старых данных удалено: ${dropped}.` : ""}`
    : "Журнал пока пуст.";
  const button = $("settingsDeveloperDownloadButton");
  if (button) button.disabled = state.timeline.length === 0 && trackCount === 0;
}
function syncControls() {
  const toggle = $("settingsDeveloperLogButton");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(state.enabled));
    toggle.textContent = `Подробный журнал боя: ${state.enabled ? "включён" : "выключен"}`;
  }
  updateStatus();
}
function installSettingsGroup() {
  if ($("developerSettingsTitle")) return;
  const card = $("settingsPanel")?.querySelector(".settings-card");
  const close = $("settingsCloseButton");
  if (!card || !close) return;
  const section = document.createElement("section");
  section.className = "settings-group";
  section.setAttribute("aria-labelledby", "developerSettingsTitle");
  section.innerHTML = `<h3 id="developerSettingsTitle">Для разработчиков</h3><div class="settings-grid"><button id="settingsDeveloperLogButton" aria-pressed="false">Подробный журнал боя: выключен</button><button id="settingsDeveloperDownloadButton">Скачать журнал</button><button id="settingsDeveloperClearButton">Очистить журнал</button></div><p id="settingsDeveloperLogStatus" class="settings-note" aria-live="polite">Журнал пока пуст.</p><p class="settings-note">Версия 3 сохраняет точную хронологию важных событий, движение игроков и судов отдельными дорожками, контрольные точки мира каждые 10 секунд и технический чёрный ящик перед ошибками. Частые пули, шаги и полёт бомб сворачиваются без потери счётчиков, времени и ключевых точек траектории. При поддержке браузером файл автоматически сжимается в .archlog.gz.</p>`;
  card.insertBefore(section, close);
  $("settingsDeveloperLogButton")?.addEventListener("click", () => setEnabled(!state.enabled));
  $("settingsDeveloperDownloadButton")?.addEventListener("click", () => { download().catch(appendError); });
  $("settingsDeveloperClearButton")?.addEventListener("click", () => { resetSession(); if (state.enabled) appendTimeline("log-cleared", {}); });
  syncControls();
}

function install() {
  installWebSocketTap();
  installSettingsGroup();
  bindBrowserEvents();
  clearInterval(state.timer);
  state.timer = setInterval(poll, POLL_INTERVAL_MS);
  if (state.enabled) {
    resetSession();
    appendTimeline("logger-enabled", {
      format: DEVELOPER_LOG_FORMAT_V3,
      restoredFromPreference: true,
      userAgent: navigator.userAgent,
      language: navigator.language,
      url: location.href,
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    }, {force: true});
  }
  poll();
}

install();

globalThis.__freeRoamDeveloperLog = {
  enable: () => setEnabled(true),
  disable: () => setEnabled(false),
  clear: resetSession,
  download,
  captureServerEvents,
  snapshot: () => buildPayload(),
};
