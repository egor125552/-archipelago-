"use strict";

import {
  activeEntitySnapshots,
  compactLogValue,
  entitySnapshotChanged,
  roundLogNumber,
} from "./free-roam-developer-log-model-v2.js?v=1";

const STORAGE_KEY = "echo-free-roam-developer-log-enabled-v1";
const MAX_ENTRIES = 60000;
const POLL_INTERVAL_MS = 250;
const ENTITY_HEARTBEAT_MS = 3000;
const NETWORK_HEARTBEAT_MS = 2000;
const SERVER_STATE_HEARTBEAT_MS = 2000;
const INPUT_PACKET_HEARTBEAT_MS = 2000;
const EVENT_MEMORY_LIMIT = 24000;
const ERROR_REPEAT_WINDOW_MS = 5000;
const ACTIVE_INPUT_KEYS = [
  "up", "down", "left", "right", "run", "pump", "repair", "action", "jump",
  "attack", "weapon", "sonar", "guide", "megaBomb",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
  "targetId", "navigationTargetId",
];

const state = {
  enabled: readEnabled(), entries: [], droppedEntries: 0, sequence: 0,
  startedAt: new Date().toISOString(), timer: 0, lastInput: null,
  lastNetwork: null, lastNetworkAt: 0, lastWorldSummary: "",
  lastServerState: null, lastServerStateAt: 0, lastPacketInput: null, lastInputPacketAt: 0,
  entitySnapshots: new Map(), seenEventIds: new Set(), seenEventQueue: [],
  lastMessage: "", lastErrorKey: "", lastErrorAt: 0, repeatedErrors: 0,
};

const $ = id => document.getElementById(id);
function readEnabled() { try { return localStorage.getItem(STORAGE_KEY) === "on"; } catch (_) { return false; } }
function saveEnabled() { try { localStorage.setItem(STORAGE_KEY, state.enabled ? "on" : "off"); } catch (_) {} }
function api() { return globalThis.__freeRoam || null; }
function currentWorld() { try { return api()?.getWorld?.() || null; } catch (_) { return null; } }

function baseEnvelope(kind) {
  const game = api();
  const world = currentWorld();
  let roomId = null;
  let playerIndex = null;
  try { roomId = game?.roomId?.() || null; } catch (_) {}
  try { playerIndex = game?.playerIndex?.() ?? null; } catch (_) {}
  return {
    seq: ++state.sequence, wallTime: new Date().toISOString(),
    performanceMs: roundLogNumber(performance.now(), 1),
    worldTime: roundLogNumber(world?.time, 3), roomId, playerIndex, kind,
  };
}

function append(kind, details = {}) {
  if (!state.enabled && !["logger-enabled", "logger-disabled"].includes(kind)) return;
  state.entries.push({...baseEnvelope(kind), ...compactLogValue(details)});
  if (state.entries.length > MAX_ENTRIES) {
    const remove = Math.min(1000, state.entries.length - MAX_ENTRIES);
    state.entries.splice(0, remove);
    state.droppedEntries += remove;
  }
  updateStatus();
}

function appendError(error) {
  const message = error?.message || String(error);
  const stack = error?.stack || null;
  const key = `${message}\n${stack || ""}`;
  const now = performance.now();
  if (key === state.lastErrorKey && now - state.lastErrorAt < ERROR_REPEAT_WINDOW_MS) {
    state.repeatedErrors += 1;
    return;
  }
  if (state.repeatedErrors > 0) append("logger-error-repeat", {
    message: state.lastErrorKey.split("\n")[0], repeated: state.repeatedErrors,
  });
  state.lastErrorKey = key;
  state.lastErrorAt = now;
  state.repeatedErrors = 0;
  append("logger-error", {message, stack});
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
function captureServerEvents(events) {
  const occurrence = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const base = eventIdentity(event, 0);
    const count = (occurrence.get(base) || 0) + 1;
    occurrence.set(base, count);
    if (rememberEvent(eventIdentity(event, count))) append("game-event", {event});
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
      type: message.type || null, sequence: message.sequence ?? null,
      serverAt: message.serverAt ?? null, ackInput: message.ackInput ?? null,
      fullWorld: Boolean(message.world),
      deltaKeys: message.worldDelta && typeof message.worldDelta === "object" ? Object.keys(message.worldDelta) : [],
      eventCount: Array.isArray(message.events) ? message.events.length : 0,
    };
    const previousSequence = Number(state.lastServerState?.sequence);
    const nextSequence = Number(snapshot.sequence);
    const sequenceGap = Number.isFinite(previousSequence) && Number.isFinite(nextSequence) && nextSequence > previousSequence + 1;
    const important = snapshot.fullWorld || snapshot.eventCount > 0 || sequenceGap
      || now - state.lastServerStateAt >= SERVER_STATE_HEARTBEAT_MS;
    if (important) {
      append("server-state", {...snapshot, compressedTicks: state.lastServerState && Number.isFinite(nextSequence) && Number.isFinite(previousSequence)
        ? Math.max(0, nextSequence - previousSequence - 1) : 0});
      state.lastServerStateAt = now;
    }
    state.lastServerState = compactLogValue(snapshot);
  } else if (!["free-pong", "heartbeat"].includes(message.type)) {
    append("server-message", {type: message.type || null, room: message.room || null, role: message.role || null, matched: message.matched ?? null});
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
      append("client-input-packet", {sequence: message.sequence ?? null, input, heartbeat: !changed});
      state.lastInputPacketAt = now;
    }
    state.lastPacketInput = input;
  } else if (!["heartbeat", "free-ping"].includes(message.type)) append("client-message", {type: message.type || null});
}

function installWebSocketTap() {
  const NativeWebSocket = globalThis.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__archipelagoDeveloperLogV2) return;
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
  Object.defineProperty(LoggedWebSocket, "__archipelagoDeveloperLogV2", {value: true});
  globalThis.WebSocket = LoggedWebSocket;
}

function scanEntities(world) {
  const now = performance.now();
  const liveKeys = new Set();
  for (const snapshot of activeEntitySnapshots(world)) {
    liveKeys.add(snapshot.key);
    const previous = state.entitySnapshots.get(snapshot.key);
    if (entitySnapshotChanged(previous, snapshot, now, ENTITY_HEARTBEAT_MS)) {
      append(previous ? "entity-state" : "entity-spawned", {entity: snapshot});
      state.entitySnapshots.set(snapshot.key, {...snapshot, loggedAt: now});
    }
  }
  for (const [key, previous] of [...state.entitySnapshots.entries()]) {
    if (liveKeys.has(key)) continue;
    append("entity-removed", {entity: previous, reason: previous.kind.startsWith("enemy") || previous.kind === "heavy-boat" ? "destroyed-or-inactive" : "removed-or-sunk"});
    state.entitySnapshots.delete(key);
  }
}

function scanInput() {
  const input = api()?.input;
  if (!input) return;
  const current = Object.fromEntries(ACTIVE_INPUT_KEYS.map(key => [key, input[key] ?? null]));
  if (!state.lastInput) { state.lastInput = current; append("input-state", {changes: current, initial: true}); return; }
  const changes = {};
  for (const key of ACTIVE_INPUT_KEYS) if (JSON.stringify(current[key]) !== JSON.stringify(state.lastInput[key])) changes[key] = current[key];
  if (Object.keys(changes).length) append("input-state", {changes});
  state.lastInput = current;
}
function networkSnapshot() { try { return api()?.networkDiagnostics?.() || null; } catch (_) { return null; } }
function scanNetwork() {
  const current = networkSnapshot();
  if (!current) return;
  const now = performance.now();
  const importantChange = !state.lastNetwork || current.reconnecting !== state.lastNetwork.reconnecting
    || current.reconnectAttempt !== state.lastNetwork.reconnectAttempt
    || Math.abs((Number(current.controlLatencyMs) || 0) - (Number(state.lastNetwork.controlLatencyMs) || 0)) >= 120
    || Math.abs((Number(current.networkRttMs) || 0) - (Number(state.lastNetwork.networkRttMs) || 0)) >= 80;
  if (importantChange || now - state.lastNetworkAt >= NETWORK_HEARTBEAT_MS) {
    append("network-state", {network: current});
    state.lastNetworkAt = now;
  }
  state.lastNetwork = compactLogValue(current);
}
function scanWorldSummary(world) {
  const summary = {
    scenarioPhase: world.freeScenario?.phase || null,
    contractId: world.freeContracts?.activeContract?.id || null,
    contractPhase: world.freeContracts?.activeContract?.phase || null,
    encounterActive: world.freeContracts?.encounterActive === true,
    threatLevel: world.freeThreatDirector?.level ?? null,
    threatEncounterId: world.freeThreatDirector?.encounterId ?? null,
    projectiles: {
      pursuer: world.freePursuerSquad?.projectiles?.length || 0,
      enemyBoats: world.freeEnemyBoats?.projectiles?.length || 0,
      hostileGunners: world.freeHostileGunners?.projectiles?.length || 0,
      hostileActors: world.freeHostileActors?.projectiles?.length || 0,
      heavy: world.freeHeavyPursuer?.projectiles?.length || 0,
      megaBombs: world.freeMegaBombs?.projectiles?.length || 0,
    },
    elite: {
      phase: world.freeEliteBoatBoss?.phase || null,
      stage: world.freeEliteBoatBoss?.stage || null,
      movementMode: world.freeEliteBoatBoss?.boat?.movementMode || null,
      bombBayState: world.freeEliteBoatBoss?.bombBayState || null,
      bombCooldown: roundLogNumber(world.freeEliteBoatBoss?.bombCooldown),
      bullets: world.freeEliteBoatBoss?.projectiles?.length || 0,
      pendingBombs: world.freeEliteBoatBoss?.bombRequests?.length || 0,
      commanderId: world.freeEliteBoatBoss?.commanderId || null,
      tacticsVersion: world.freeEliteBossTacticsV12?.version || null,
    },
  };
  const serialized = JSON.stringify(summary);
  if (serialized !== state.lastWorldSummary) { state.lastWorldSummary = serialized; append("world-summary", {summary}); }
}
function poll() {
  if (!state.enabled) return;
  try { scanInput(); scanNetwork(); const world = currentWorld(); if (!world) return; scanEntities(world); scanWorldSummary(world); }
  catch (error) { appendError(error); }
}

function resetSession() {
  state.entries = []; state.droppedEntries = 0; state.sequence = 0; state.startedAt = new Date().toISOString();
  state.lastInput = null; state.lastNetwork = null; state.lastNetworkAt = 0; state.lastWorldSummary = "";
  state.lastServerState = null; state.lastServerStateAt = 0; state.lastPacketInput = null; state.lastInputPacketAt = 0;
  state.entitySnapshots.clear(); state.seenEventIds.clear(); state.seenEventQueue = [];
  state.lastMessage = ""; state.lastErrorKey = ""; state.lastErrorAt = 0; state.repeatedErrors = 0;
  updateStatus();
}
function setEnabled(enabled) {
  const desired = Boolean(enabled);
  if (state.enabled === desired) return;
  state.enabled = desired; saveEnabled();
  if (desired) {
    resetSession();
    append("logger-enabled", {format: "archipelago-developer-log-v2", userAgent: navigator.userAgent, language: navigator.language, url: location.href, viewport: {width: innerWidth, height: innerHeight, devicePixelRatio}});
    poll();
  } else append("logger-disabled", {});
  syncControls();
}
function fileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let room = "menu"; try { room = api()?.roomId?.() || room; } catch (_) {}
  return `archipelago-debug-${room}-${stamp}.json`;
}
function download() {
  if (state.repeatedErrors > 0) { append("logger-error-repeat", {message: state.lastErrorKey.split("\n")[0], repeated: state.repeatedErrors}); state.repeatedErrors = 0; }
  const payload = {format: "archipelago-developer-log-v2", startedAt: state.startedAt, exportedAt: new Date().toISOString(), enabled: state.enabled, droppedEntries: state.droppedEntries, entryCount: state.entries.length, entries: state.entries};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = fileName(); document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); append("log-downloaded", {entryCount: state.entries.length, bytes: blob.size});
}

function targetDescription(target) {
  if (!(target instanceof Element)) return {tag: null};
  return {tag: target.tagName.toLowerCase(), id: target.id || null, role: target.getAttribute("role"), ariaLabel: target.getAttribute("aria-label"), text: String(target.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160) || null};
}
function bindBrowserEvents() {
  window.addEventListener("keydown", event => { if (state.enabled) append("keyboard", {action: "down", code: event.code, key: event.key, repeat: event.repeat, target: targetDescription(event.target)}); }, true);
  window.addEventListener("keyup", event => { if (state.enabled) append("keyboard", {action: "up", code: event.code, key: event.key, target: targetDescription(event.target)}); }, true);
  for (const name of ["pointerdown", "pointerup", "click"]) document.addEventListener(name, event => {
    if (!state.enabled) return;
    append("pointer", {action: name, pointerType: event.pointerType || null, pointerId: event.pointerId ?? null, button: event.button ?? null, buttons: event.buttons ?? null, clientX: roundLogNumber(event.clientX, 0), clientY: roundLogNumber(event.clientY, 0), target: targetDescription(event.target)});
  }, true);
  document.addEventListener("visibilitychange", () => append("page-visibility", {hidden: document.hidden}));
  window.addEventListener("online", () => append("browser-network", {online: true}));
  window.addEventListener("offline", () => append("browser-network", {online: false}));
  window.addEventListener("focus", () => append("window-focus", {focused: true}));
  window.addEventListener("blur", () => append("window-focus", {focused: false}));
  window.addEventListener("error", event => append("javascript-error", {message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack || null}));
  window.addEventListener("unhandledrejection", event => append("promise-rejection", {reason: event.reason?.stack || event.reason?.message || String(event.reason)}));
  const message = $("message");
  if (message) new MutationObserver(() => { const text = String(message.textContent || "").trim(); if (!state.enabled || !text || text === state.lastMessage) return; state.lastMessage = text; append("ui-message", {text}); }).observe(message, {childList: true, characterData: true, subtree: true});
}
function updateStatus() {
  const output = $("settingsDeveloperLogStatus");
  if (!output) return;
  output.textContent = state.entries.length ? `Записей: ${state.entries.length}${state.droppedEntries ? `. Старых удалено: ${state.droppedEntries}` : ""}.` : "Журнал пока пуст.";
  const button = $("settingsDeveloperDownloadButton"); if (button) button.disabled = state.entries.length === 0;
}
function syncControls() {
  const toggle = $("settingsDeveloperLogButton");
  if (toggle) { toggle.setAttribute("aria-pressed", String(state.enabled)); toggle.textContent = `Логирование всего: ${state.enabled ? "включено" : "выключено"}`; }
  updateStatus();
}
function installSettingsGroup() {
  if ($("developerSettingsTitle")) return;
  const card = $("settingsPanel")?.querySelector(".settings-card"); const close = $("settingsCloseButton");
  if (!card || !close) return;
  const section = document.createElement("section"); section.className = "settings-group"; section.setAttribute("aria-labelledby", "developerSettingsTitle");
  section.innerHTML = `<h3 id="developerSettingsTitle">Для разработчиков</h3><div class="settings-grid"><button id="settingsDeveloperLogButton" aria-pressed="false">Логирование всего: выключено</button><button id="settingsDeveloperDownloadButton">Скачать журнал</button><button id="settingsDeveloperClearButton">Очистить журнал</button></div><p id="settingsDeveloperLogStatus" class="settings-note" aria-live="polite">Журнал пока пуст.</p><p class="settings-note">Версия 2 записывает нажатия, исходящие пакеты управления, все серверные игровые события, сеть, игроков, лодки и живых врагов. Повторяющиеся ошибки сжимаются в одну запись.</p>`;
  card.insertBefore(section, close);
  $("settingsDeveloperLogButton")?.addEventListener("click", () => setEnabled(!state.enabled));
  $("settingsDeveloperDownloadButton")?.addEventListener("click", download);
  $("settingsDeveloperClearButton")?.addEventListener("click", () => { resetSession(); if (state.enabled) append("log-cleared", {}); });
  syncControls();
}
function install() {
  installWebSocketTap(); installSettingsGroup(); bindBrowserEvents(); clearInterval(state.timer); state.timer = setInterval(poll, POLL_INTERVAL_MS);
  if (state.enabled) { resetSession(); append("logger-enabled", {format: "archipelago-developer-log-v2", restoredFromPreference: true, userAgent: navigator.userAgent, language: navigator.language, url: location.href, viewport: {width: innerWidth, height: innerHeight, devicePixelRatio}}); }
  poll();
}

install();

globalThis.__freeRoamDeveloperLog = {
  enable: () => setEnabled(true), disable: () => setEnabled(false), clear: resetSession, download, captureServerEvents,
  snapshot: () => ({format: "archipelago-developer-log-v2", enabled: state.enabled, entryCount: state.entries.length, droppedEntries: state.droppedEntries, startedAt: state.startedAt, entries: state.entries.slice()}),
};
