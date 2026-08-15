"use strict";

import {
  activeEntitySnapshots,
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
const POLL_MS = 250;
const TRACK_HEARTBEAT_MS = 3000;
const CHECKPOINT_MS = 10000;
const NETWORK_HEARTBEAT_MS = 2000;
const SERVER_HEARTBEAT_MS = 2000;
const INPUT_PACKET_HEARTBEAT_MS = 2000;
const AGGREGATE_MS = 500;
const COUNTER_MS = 2000;
const BOMB_TRACE_MS = 500;
const BLACK_BOX_MS = 20000;
const MAX_TIMELINE = 120000;
const MAX_TRACK_SAMPLES = 260000;
const MAX_CHECKPOINTS = 2000;
const MAX_BLACK_BOX = 3000;
const MAX_INCIDENTS = 4;
const MAX_SEEN_EVENTS = 30000;

const INPUT_KEYS = [
  "up", "down", "left", "right", "run", "pump", "repair", "action", "jump",
  "attack", "weapon", "sonar", "guide", "megaBomb", "respawn",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
  "targetId", "navigationTargetId",
];
const RAPID_EVENTS = new Set([
  "elite-turret-shot", "elite-bullet-ended", "elite-bullet-flyby",
  "elite-bullet-direct-hit", "vessel-mounted-shot",
]);
const COUNTER_EVENTS = new Set([
  "footstep", "swim-step", "hostile-footstep", "hostile-swim-step", "pursuer-aim",
]);

const state = {
  enabled: readEnabled(),
  startedAt: new Date().toISOString(),
  startedPerf: performance.now(),
  sequence: 0,
  timeline: [],
  tracks: new Map(),
  checkpoints: [],
  incidents: [],
  blackBox: [],
  aggregates: new Map(),
  seenEvents: new Set(),
  seenQueue: [],
  entitySnapshots: new Map(),
  entityLoggedAt: new Map(),
  lastInput: null,
  lastPacketInput: null,
  lastInputPacketAt: 0,
  lastNetwork: null,
  lastNetworkAt: 0,
  lastServerState: null,
  lastServerAt: 0,
  lastPhase: "",
  lastBombTraceAt: new Map(),
  lastCheckpointAt: -Infinity,
  lastMessage: "",
  droppedTimeline: 0,
  droppedTrackSamples: 0,
  droppedCheckpoints: 0,
  droppedIncidents: 0,
  roomId: null,
  playerIndex: null,
  timer: 0,
};

const $ = id => document.getElementById(id);
function readEnabled() { try { return localStorage.getItem(STORAGE_KEY) === "on"; } catch (_) { return false; } }
function saveEnabled() { try { localStorage.setItem(STORAGE_KEY, state.enabled ? "on" : "off"); } catch (_) {} }
function api() { return globalThis.__freeRoam || null; }
function world() { try { return api()?.getWorld?.() || null; } catch (_) { return null; } }
function elapsedMs() { return Math.max(0, Math.round(performance.now() - state.startedPerf)); }
function worldTime() { return roundLogNumber(world()?.time, 3); }

function trimTimeline() {
  if (state.timeline.length <= MAX_TIMELINE) return;
  const count = Math.min(2000, state.timeline.length - MAX_TIMELINE);
  state.timeline.splice(0, count);
  state.droppedTimeline += count;
}
function appendTimeline(kind, payload = {}, force = false) {
  if (!state.enabled && !force) return;
  state.timeline.push([elapsedMs(), worldTime(), ++state.sequence, kind, compactLogValue(payload)]);
  trimTimeline();
  updateStatus();
}
function appendBlackBox(kind, payload = {}) {
  const now = elapsedMs();
  state.blackBox.push([now, kind, compactLogValue(payload)]);
  const cutoff = now - BLACK_BOX_MS;
  while (state.blackBox.length && (state.blackBox[0][0] < cutoff || state.blackBox.length > MAX_BLACK_BOX)) state.blackBox.shift();
}
function freezeBlackBox(reason, details = {}) {
  if (!state.blackBox.length) return;
  state.incidents.push({
    atMs: elapsedMs(),
    worldTime: worldTime(),
    reason,
    details: compactLogValue(details),
    records: state.blackBox.map(row => [...row]),
  });
  while (state.incidents.length > MAX_INCIDENTS) {
    state.incidents.shift();
    state.droppedIncidents += 1;
  }
}
function appendError(error, kind = "logger-error") {
  const message = error?.message || String(error);
  freezeBlackBox(kind, {message});
  appendTimeline(kind, {message, stack: error?.stack || null});
}

function eventId(event, occurrence) {
  return [roundLogNumber(event?.at, 3), event?.type, event?.sourcePlayer, event?.targetPlayer,
    event?.targetId, event?.projectileId, roundLogNumber(event?.x), roundLogNumber(event?.y), occurrence].join("|");
}
function rememberEvent(id) {
  if (state.seenEvents.has(id)) return false;
  state.seenEvents.add(id);
  state.seenQueue.push(id);
  while (state.seenQueue.length > MAX_SEEN_EVENTS) state.seenEvents.delete(state.seenQueue.shift());
  return true;
}
function aggregateKey(event, bucketMs) {
  return [Math.floor(elapsedMs() / bucketMs), event?.type, event?.turretId, event?.weapon,
    event?.reason, event?.sourcePlayer, event?.targetPlayer, event?.targetId].join("|");
}
function addAggregate(event, bucketMs = AGGREGATE_MS) {
  const key = aggregateKey(event, bucketMs);
  let row = state.aggregates.get(key);
  if (!row) {
    row = {
      bucketStartMs: Math.floor(elapsedMs() / bucketMs) * bucketMs,
      bucketMs,
      type: event?.type || "unknown",
      firstAt: roundLogNumber(event?.at, 3), lastAt: roundLogNumber(event?.at, 3),
      count: 0, damage: 0,
      firstProjectileId: event?.projectileId || null, lastProjectileId: event?.projectileId || null,
      turretId: event?.turretId || null, weapon: event?.weapon || null, reason: event?.reason || null,
      sourcePlayer: Number.isInteger(event?.sourcePlayer) ? event.sourcePlayer : null,
      targetPlayer: Number.isInteger(event?.targetPlayer) ? event.targetPlayer : null,
      targetId: event?.targetId || null,
      firstX: roundLogNumber(event?.x), firstY: roundLogNumber(event?.y),
      lastX: roundLogNumber(event?.x), lastY: roundLogNumber(event?.y), hits: 0, misses: 0,
    };
    state.aggregates.set(key, row);
  }
  row.count += 1;
  row.lastAt = roundLogNumber(event?.at, 3);
  row.lastProjectileId = event?.projectileId || row.lastProjectileId;
  row.lastX = roundLogNumber(event?.x); row.lastY = roundLogNumber(event?.y);
  if (Number.isFinite(Number(event?.damage))) row.damage = roundLogNumber(row.damage + Number(event.damage), 3);
  if (event?.hit === true || event?.applied === true) row.hits += 1;
  if (event?.hit === false || event?.applied === false) row.misses += 1;
}
function flushAggregates(force = false) {
  const now = elapsedMs();
  for (const [key, row] of [...state.aggregates.entries()]) {
    if (!force && now < row.bucketStartMs + row.bucketMs + 50) continue;
    state.timeline.push([row.bucketStartMs, row.lastAt, ++state.sequence, "event-aggregate", summarizeAggregate(row)]);
    state.aggregates.delete(key);
  }
  trimTimeline();
}

function compactBomb(event) {
  return {
    projectileId: event?.projectileId || event?.id || null,
    at: roundLogNumber(event?.at, 3), x: roundLogNumber(event?.x), y: roundLogNumber(event?.y), z: roundLogNumber(event?.z),
    vx: roundLogNumber(event?.vx), vy: roundLogNumber(event?.vy), vz: roundLogNumber(event?.vz),
    age: roundLogNumber(event?.age), energy: roundLogNumber(event?.energy), bounces: event?.bounces ?? 0,
    armed: event?.armed === true, surface: event?.surface || null,
    targetX: roundLogNumber(event?.targetX), targetY: roundLogNumber(event?.targetY),
    targetPlayer: Number.isInteger(event?.targetPlayer) ? event.targetPlayer : null,
    sourceBoatId: event?.sourceBoatId || null, sourceActorId: event?.sourceActorId || null,
  };
}
function captureBombFlight(event) {
  const id = event?.projectileId || event?.id || "unknown";
  const now = elapsedMs();
  const previous = state.lastBombTraceAt.get(id) ?? -Infinity;
  const trace = compactBomb(event);
  if (now - previous >= BOMB_TRACE_MS || event?.armed === true || Number(event?.bounces) > 0) {
    state.lastBombTraceAt.set(id, now);
    appendTimeline("bomb-trace", trace);
    appendBlackBox("bomb-trace", trace);
  }
}
function captureServerEvents(events) {
  const occurrences = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const base = eventId(event, 0);
    const n = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, n);
    if (!rememberEvent(eventId(event, n))) continue;
    const type = event?.type || "unknown";
    if (type === "mega-bomb-flight") { captureBombFlight(event); continue; }
    if (COUNTER_EVENTS.has(type)) { addAggregate(event, COUNTER_MS); continue; }
    if (RAPID_EVENTS.has(type)) {
      addAggregate(event);
      appendBlackBox(type, {
        at: roundLogNumber(event?.at, 3), projectileId: event?.projectileId || null,
        turretId: event?.turretId || null, targetPlayer: event?.targetPlayer ?? null,
        targetId: event?.targetId || null, damage: roundLogNumber(event?.damage),
        x: roundLogNumber(event?.x), y: roundLogNumber(event?.y),
      });
      continue;
    }
    appendTimeline("game-event", {type, at: roundLogNumber(event?.at, 3), data: stripEventEnvelope(event)});
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
      type: message.type || null, sequence: message.sequence ?? null, serverAt: message.serverAt ?? null,
      ackInput: message.ackInput ?? null, fullWorld: Boolean(message.world),
      deltaKeys: message.worldDelta && typeof message.worldDelta === "object" ? Object.keys(message.worldDelta) : [],
      eventCount: Array.isArray(message.events) ? message.events.length : 0,
    };
    const prev = Number(state.lastServerState?.sequence);
    const next = Number(snapshot.sequence);
    const gap = Number.isFinite(prev) && Number.isFinite(next) ? Math.max(0, next - prev - 1) : 0;
    if (snapshot.fullWorld || gap > 0 || now - state.lastServerAt >= SERVER_HEARTBEAT_MS) {
      appendTimeline("server-state", {...snapshot, compressedTicks: gap});
      state.lastServerAt = now;
    }
    state.lastServerState = compactLogValue(snapshot);
  } else if (!["free-pong", "heartbeat"].includes(message.type)) {
    appendTimeline("server-message", {type: message.type || null, room: message.room || null, role: message.role || null});
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
  }
}
function installWebSocketTap() {
  const Native = globalThis.WebSocket;
  if (!Native || Native.__archipelagoDeveloperLogV4) return;
  class LoggedWebSocket extends Native {
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
  Object.defineProperty(LoggedWebSocket, "__archipelagoDeveloperLogV4", {value: true});
  globalThis.WebSocket = LoggedWebSocket;
}

function sanitizeSnapshot(snapshot) {
  const out = {...snapshot};
  delete out.bombCooldown; delete out.salvoRemaining; delete out.bulletCount; delete out.pendingBombCount;
  if (Array.isArray(out.turrets)) out.turrets = out.turrets.map(t => ({
    id: t.id, side: t.side, hp: t.hp, state: t.state, destroyed: t.destroyed === true, targetPlayer: t.targetPlayer ?? null,
  }));
  return out;
}
function addTrack(raw, now) {
  const next = sanitizeSnapshot(raw);
  const previous = state.entitySnapshots.get(next.key) || null;
  const lastAt = state.entityLoggedAt.get(next.key) ?? -Infinity;
  if (previous && now - lastAt < TRACK_HEARTBEAT_MS && !changedTrackSample(previous, next)) return;
  let track = state.tracks.get(next.key);
  if (!track) { track = {kind: next.kind, id: next.id, samples: []}; state.tracks.set(next.key, track); }
  track.samples.push(makeTrackSample(now, previous, next));
  state.entitySnapshots.set(next.key, compactLogValue(next));
  state.entityLoggedAt.set(next.key, now);
}
function trimTracks() {
  let count = 0;
  for (const track of state.tracks.values()) count += track.samples.length;
  if (count <= MAX_TRACK_SAMPLES) return;
  let need = Math.min(5000, count - MAX_TRACK_SAMPLES);
  for (const track of [...state.tracks.values()].sort((a, b) => b.samples.length - a.samples.length)) {
    while (track.samples.length > 1 && need > 0) { track.samples.shift(); need -= 1; state.droppedTrackSamples += 1; }
    if (need <= 0) break;
  }
}
function scanEntities(current) {
  const now = elapsedMs();
  const live = new Set();
  for (const snapshot of activeEntitySnapshots(current)) {
    live.add(snapshot.key);
    const existed = state.entitySnapshots.has(snapshot.key);
    addTrack(snapshot, now);
    if (!existed) appendTimeline("entity-spawned", {key: snapshot.key, kind: snapshot.kind, id: snapshot.id});
  }
  for (const [key, previous] of [...state.entitySnapshots.entries()]) {
    if (live.has(key)) continue;
    appendTimeline("entity-removed", {key, kind: previous.kind, id: previous.id, last: previous});
    state.entitySnapshots.delete(key); state.entityLoggedAt.delete(key);
  }
  trimTracks();
}
function scanInput() {
  const input = api()?.input;
  if (!input) return;
  const current = Object.fromEntries(INPUT_KEYS.map(key => [key, input[key] ?? null]));
  if (!state.lastInput) { state.lastInput = current; appendTimeline("input-state", {changes: current, initial: true}); return; }
  const changes = {};
  for (const key of INPUT_KEYS) if (JSON.stringify(current[key]) !== JSON.stringify(state.lastInput[key])) changes[key] = current[key];
  if (Object.keys(changes).length) appendTimeline("input-state", {changes});
  state.lastInput = current;
}
function scanNetwork() {
  let current = null;
  try { current = api()?.networkDiagnostics?.() || null; } catch (_) {}
  if (!current) return;
  const now = performance.now();
  const changed = !state.lastNetwork
    || current.reconnecting !== state.lastNetwork.reconnecting
    || current.reconnectAttempt !== state.lastNetwork.reconnectAttempt
    || Math.abs((Number(current.controlLatencyMs) || 0) - (Number(state.lastNetwork.controlLatencyMs) || 0)) >= 120
    || Math.abs((Number(current.networkRttMs) || 0) - (Number(state.lastNetwork.networkRttMs) || 0)) >= 80;
  if (changed || now - state.lastNetworkAt >= NETWORK_HEARTBEAT_MS) {
    appendTimeline("network-state", {network: current});
    state.lastNetworkAt = now;
  }
  state.lastNetwork = compactLogValue(current);
}
function phaseSummary(current) {
  return {
    scenarioPhase: current.freeScenario?.phase || null,
    contractId: current.freeContracts?.activeContract?.id || null,
    contractPhase: current.freeContracts?.activeContract?.phase || null,
    encounterActive: current.freeContracts?.encounterActive === true,
    threatLevel: current.freeThreatDirector?.level ?? null,
    threatEncounterId: current.freeThreatDirector?.encounterId ?? null,
    elite: {
      phase: current.freeEliteBoatBoss?.phase || null,
      stage: current.freeEliteBoatBoss?.stage || null,
      movementMode: current.freeEliteBoatBoss?.boat?.movementMode || null,
      bombBayState: current.freeEliteBoatBoss?.bombBayState || null,
      commanderId: current.freeEliteBoatBoss?.commanderId || null,
    },
  };
}
function scanPhase(current) {
  const summary = phaseSummary(current);
  const serialized = JSON.stringify(summary);
  if (serialized === state.lastPhase) return;
  state.lastPhase = serialized;
  appendTimeline("phase-summary", {summary});
}
function makeCheckpoint(current, force = false) {
  const now = elapsedMs();
  if (!force && now - state.lastCheckpointAt < CHECKPOINT_MS) return;
  state.checkpoints.push({
    atMs: now, worldTime: roundLogNumber(current?.time, 3), phase: phaseSummary(current),
    input: compactLogValue(state.lastInput), network: compactLogValue(state.lastNetwork),
    entities: activeEntitySnapshots(current).map(compactLogValue),
  });
  state.lastCheckpointAt = now;
  while (state.checkpoints.length > MAX_CHECKPOINTS) { state.checkpoints.shift(); state.droppedCheckpoints += 1; }
}
function refreshContext() {
  let roomId = null; let playerIndex = null;
  try { roomId = api()?.roomId?.() || null; } catch (_) {}
  try { playerIndex = api()?.playerIndex?.() ?? null; } catch (_) {}
  if (roomId !== state.roomId || playerIndex !== state.playerIndex) {
    state.roomId = roomId; state.playerIndex = playerIndex;
    appendTimeline("context", {roomId, playerIndex});
  }
}
function poll() {
  if (!state.enabled) return;
  try {
    refreshContext(); flushAggregates(); scanInput(); scanNetwork();
    const current = world();
    if (!current) return;
    scanEntities(current); scanPhase(current); makeCheckpoint(current);
  } catch (error) { appendError(error); }
}

function resetSession() {
  state.startedAt = new Date().toISOString(); state.startedPerf = performance.now(); state.sequence = 0;
  state.timeline = []; state.tracks = new Map(); state.checkpoints = []; state.incidents = []; state.blackBox = [];
  state.aggregates = new Map(); state.seenEvents = new Set(); state.seenQueue = [];
  state.entitySnapshots = new Map(); state.entityLoggedAt = new Map();
  state.lastInput = null; state.lastPacketInput = null; state.lastInputPacketAt = 0;
  state.lastNetwork = null; state.lastNetworkAt = 0; state.lastServerState = null; state.lastServerAt = 0;
  state.lastPhase = ""; state.lastBombTraceAt = new Map(); state.lastCheckpointAt = -Infinity; state.lastMessage = "";
  state.droppedTimeline = 0; state.droppedTrackSamples = 0; state.droppedCheckpoints = 0; state.droppedIncidents = 0;
  state.roomId = null; state.playerIndex = null; updateStatus();
}
function setEnabled(value) {
  const desired = Boolean(value);
  if (state.enabled === desired) return;
  state.enabled = desired; saveEnabled();
  if (desired) {
    resetSession();
    appendTimeline("logger-enabled", {format: DEVELOPER_LOG_FORMAT_V3, implementation: "v4", userAgent: navigator.userAgent}, true);
    poll();
  } else {
    flushAggregates(true); appendTimeline("logger-disabled", {}, true);
  }
  syncControls();
}
function serializableTracks() { return Object.fromEntries([...state.tracks.entries()]); }
function buildPayload() {
  flushAggregates(true);
  const current = world(); if (current) makeCheckpoint(current, true);
  return {
    format: DEVELOPER_LOG_FORMAT_V3,
    implementation: "free-roam-developer-log-v4",
    schema: {
      timeline: "[elapsedMs, worldTime, sequence, kind, payload]",
      trackSample: "[elapsedMs, fieldIndex, value, ...]",
      checkpoints: "reconstruction snapshots every 10 seconds",
      incidents: "up to four 20-second black-box windows for real JavaScript/logger failures only",
      serverSequenceGaps: "server-state.compressedTicks; never freezes or duplicates the black box",
    },
    startedAt: state.startedAt, exportedAt: new Date().toISOString(), enabled: state.enabled,
    roomId: state.roomId, playerIndex: state.playerIndex,
    droppedTimeline: state.droppedTimeline, droppedTrackSamples: state.droppedTrackSamples,
    droppedCheckpoints: state.droppedCheckpoints, droppedIncidents: state.droppedIncidents,
    timelineCount: state.timeline.length,
    trackSampleCount: [...state.tracks.values()].reduce((sum, t) => sum + t.samples.length, 0),
    checkpointCount: state.checkpoints.length, incidentCount: state.incidents.length,
    timeline: [...state.timeline].sort((a, b) => (a[0] - b[0]) || (a[2] - b[2])),
    tracks: serializableTracks(), checkpoints: state.checkpoints, incidents: state.incidents,
  };
}
async function gzipBlob(text) {
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], {type: "application/gzip"});
}
function fileStem() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let room = "menu"; try { room = api()?.roomId?.() || room; } catch (_) {}
  return `Архипелаг — журнал ${room} — ${stamp}`;
}
async function download() {
  const payload = buildPayload(); const text = JSON.stringify(payload);
  let blob = null; let extension = ".archlog";
  try { blob = await gzipBlob(text); if (blob) extension = ".archlog.gz"; } catch (error) { appendError(error, "logger-compression-error"); }
  if (!blob) blob = new Blob([text], {type: "application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${fileStem()}${extension}`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  appendTimeline("log-downloaded", {bytes: blob.size, compressed: extension.endsWith(".gz"), incidentCount: payload.incidentCount});
}

function bindBrowserEvents() {
  window.addEventListener("error", event => {
    freezeBlackBox("javascript-error", {message: event.message, filename: event.filename, line: event.lineno, column: event.colno});
    appendTimeline("javascript-error", {message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack || null});
  });
  window.addEventListener("unhandledrejection", event => {
    const reason = event.reason?.stack || event.reason?.message || String(event.reason);
    freezeBlackBox("promise-rejection", {reason}); appendTimeline("promise-rejection", {reason});
  });
  window.addEventListener("online", () => appendTimeline("browser-network", {online: true}));
  window.addEventListener("offline", () => appendTimeline("browser-network", {online: false}));
  document.addEventListener("visibilitychange", () => appendTimeline("page-visibility", {hidden: document.hidden}));
  const message = $("message");
  if (message) new MutationObserver(() => {
    const text = String(message.textContent || "").trim();
    if (!state.enabled || !text || text === state.lastMessage) return;
    state.lastMessage = text; appendTimeline("ui-message", {text});
  }).observe(message, {childList: true, characterData: true, subtree: true});
}
function updateStatus() {
  const output = $("settingsDeveloperLogStatus"); if (!output) return;
  const tracks = [...state.tracks.values()].reduce((sum, t) => sum + t.samples.length, 0);
  output.textContent = state.timeline.length || tracks
    ? `Событий: ${state.timeline.length}. Точек движения: ${tracks}. Контрольных точек: ${state.checkpoints.length}. Аварийных окон: ${state.incidents.length}.`
    : "Журнал пока пуст.";
  const button = $("settingsDeveloperDownloadButton"); if (button) button.disabled = state.timeline.length === 0 && tracks === 0;
}
function syncControls() {
  const button = $("settingsDeveloperLogButton");
  if (button) { button.setAttribute("aria-pressed", String(state.enabled)); button.textContent = `Подробный журнал боя: ${state.enabled ? "включён" : "выключен"}`; }
  updateStatus();
}
function installSettings() {
  if ($("developerSettingsTitle")) return;
  const card = $("settingsPanel")?.querySelector(".settings-card"); const close = $("settingsCloseButton");
  if (!card || !close) return;
  const section = document.createElement("section"); section.className = "settings-group"; section.setAttribute("aria-labelledby", "developerSettingsTitle");
  section.innerHTML = `<h3 id="developerSettingsTitle">Для разработчиков</h3><div class="settings-grid"><button id="settingsDeveloperLogButton" aria-pressed="false">Подробный журнал боя: выключен</button><button id="settingsDeveloperDownloadButton">Скачать журнал</button><button id="settingsDeveloperClearButton">Очистить журнал</button></div><p id="settingsDeveloperLogStatus" class="settings-note" aria-live="polite">Журнал пока пуст.</p><p class="settings-note">Журнал сохраняет точную хронологию, дорожки движения, управление и контрольные точки каждые 10 секунд. Пропуски серверных кадров записываются одним компактным числом и больше не копируют 20 секунд боя. Чёрный ящик сохраняется только для настоящих ошибок и ограничен четырьмя окнами. Файл автоматически сжимается в .archlog.gz, когда браузер это поддерживает.</p>`;
  card.insertBefore(section, close);
  $("settingsDeveloperLogButton")?.addEventListener("click", () => setEnabled(!state.enabled));
  $("settingsDeveloperDownloadButton")?.addEventListener("click", () => download().catch(appendError));
  $("settingsDeveloperClearButton")?.addEventListener("click", () => { resetSession(); if (state.enabled) appendTimeline("log-cleared", {}); });
  syncControls();
}
function install() {
  installWebSocketTap(); installSettings(); bindBrowserEvents();
  clearInterval(state.timer); state.timer = setInterval(poll, POLL_MS);
  if (state.enabled) {
    resetSession(); appendTimeline("logger-enabled", {format: DEVELOPER_LOG_FORMAT_V3, implementation: "v4", restoredFromPreference: true, userAgent: navigator.userAgent}, true);
  }
  poll();
}

install();
globalThis.__freeRoamDeveloperLog = {
  enable: () => setEnabled(true), disable: () => setEnabled(false), clear: resetSession,
  download, captureServerEvents, snapshot: buildPayload,
};
