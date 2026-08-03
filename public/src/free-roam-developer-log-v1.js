"use strict";

const STORAGE_KEY = "echo-free-roam-developer-log-enabled-v1";
const MAX_ENTRIES = 60000;
const POLL_INTERVAL_MS = 250;
const ENTITY_HEARTBEAT_MS = 3000;
const NETWORK_HEARTBEAT_MS = 2000;
const EVENT_MEMORY_LIMIT = 24000;
const ACTIVE_INPUT_KEYS = [
  "up", "down", "left", "right", "run", "pump", "repair", "action", "jump",
  "attack", "weapon", "sonar", "guide", "shopPrevious", "shopNext", "shopBuy",
  "shopClose", "boardPrevious", "boardNext", "boardAccept", "boardClose",
  "targetId", "navigationTargetId",
];

const state = {
  enabled: readEnabled(),
  entries: [],
  droppedEntries: 0,
  sequence: 0,
  startedAt: new Date().toISOString(),
  timer: 0,
  lastInput: null,
  lastNetwork: null,
  lastNetworkAt: 0,
  entitySnapshots: new Map(),
  seenEventIds: new Set(),
  seenEventQueue: [],
  lastMessage: "",
};

function $(id) {
  return document.getElementById(id);
}

function readEnabled() {
  try { return localStorage.getItem(STORAGE_KEY) === "on"; }
  catch (_) { return false; }
}

function saveEnabled() {
  try { localStorage.setItem(STORAGE_KEY, state.enabled ? "on" : "off"); }
  catch (_) {}
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function compactObject(value, depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return round(value, 3);
  if (depth >= 4) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 80).map(item => compactObject(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["audioBuffer", "buffer", "ctx", "socket"].includes(key)) continue;
    result[key] = compactObject(item, depth + 1);
  }
  return result;
}

function api() {
  return globalThis.__freeRoam || null;
}

function currentWorld() {
  try { return api()?.getWorld?.() || null; }
  catch (_) { return null; }
}

function baseEnvelope(kind) {
  const game = api();
  const world = currentWorld();
  let roomId = null;
  let playerIndex = null;
  try { roomId = game?.roomId?.() || null; } catch (_) {}
  try { playerIndex = game?.playerIndex?.() ?? null; } catch (_) {}
  return {
    seq: ++state.sequence,
    wallTime: new Date().toISOString(),
    performanceMs: round(performance.now(), 1),
    worldTime: round(world?.time, 3),
    roomId,
    playerIndex,
    kind,
  };
}

function append(kind, details = {}) {
  if (!state.enabled && !["logger-enabled", "logger-disabled"].includes(kind)) return;
  const entry = {...baseEnvelope(kind), ...compactObject(details)};
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    const remove = Math.min(1000, state.entries.length - MAX_ENTRIES);
    state.entries.splice(0, remove);
    state.droppedEntries += remove;
  }
  updateStatus();
}

function entitySnapshot(kind, id, entity, extra = {}) {
  return {
    key: `${kind}:${id}`,
    kind,
    id: String(id),
    x: round(entity?.x),
    y: round(entity?.y),
    heading: round(entity?.heading),
    speed: round(entity?.speed),
    mode: entity?.mode ?? null,
    state: entity?.state ?? null,
    active: entity?.active ?? true,
    health: round(entity?.health),
    hull: round(entity?.hull),
    engineHealth: round(entity?.engineHealth),
    turretHealth: round(entity?.turretHealth),
    targetPlayer: Number.isInteger(Number(entity?.targetPlayer)) ? Number(entity.targetPlayer) : null,
    ...extra,
  };
}

function activeEntities(world) {
  const result = [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    const player = world.players[index];
    if (!player) continue;
    result.push(entitySnapshot("player", index, player, {
      alive: player.combat?.alive !== false,
      equipped: player.combat?.equipped || null,
      ammo: round(player.combat?.ammo, 0),
      pistolAmmo: round(player.combat?.pistolAmmo, 0),
      lockedTargetId: player.combat?.lockedTargetId || null,
      activeBoat: player.activeBoat ?? null,
      present: world.freeActivities?.presence?.[index] !== false,
    }));
  }

  for (const boat of world.boats || []) {
    if (!boat || boat.sunk) continue;
    result.push(entitySnapshot("player-boat", boat.id ?? "unknown", boat, {
      owner: boat.owner ?? null,
      driver: boat.driver ?? null,
      leak: round(boat.leak),
      fuel: round(boat.fuel),
    }));
  }

  const marauder = world.freeActivities?.marauder;
  if (marauder?.active && !marauder.destroyed) {
    result.push(entitySnapshot("enemy-boat", marauder.id || "pursuer-1", marauder, {role: "marauder"}));
  }
  for (const escort of world.freePursuerSquad?.escorts || []) {
    if (escort?.active && !escort.destroyed) result.push(entitySnapshot("enemy-boat", escort.id, escort, {role: "escort"}));
  }
  for (const boat of world.freeEnemyBoats?.boats || []) {
    if (boat?.active && !boat.destroyed) result.push(entitySnapshot("enemy-boat", boat.id, boat, {role: boat.role || null}));
  }
  for (const gunner of world.freeHostileGunners?.gunners || []) {
    if (gunner?.active && !gunner.destroyed) result.push(entitySnapshot("enemy-gunner", gunner.id, gunner, {pursuerId: gunner.pursuerId || null}));
  }
  for (const actor of world.freeHostileActors?.actors || []) {
    if (actor?.active && !actor.destroyed) result.push(entitySnapshot("enemy-actor", actor.id, actor, {
      weapon: actor.weapon || null,
      elite: actor.elite === true,
      boatId: actor.boatId || null,
    }));
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed) {
    result.push(entitySnapshot("heavy-boat", heavy.id || "heavy-pursuer", heavy, {
      phase: world.freeCombatAiV164?.heavy?.phase || null,
      repairSystem: world.freeCombatAiV164?.heavy?.repairSystem || null,
      repairProgress: round(world.freeCombatAiV164?.heavy?.repairProgress),
      repairPlates: round(world.freeCombatAiV164?.heavy?.repairPlates, 0),
      tacticalMode: world.freeCombatAiV168?.mode || null,
      suppressionPhase: world.freeCombatAiV170?.phase || null,
      destination: compactObject(world.freeCombatAiV164?.heavy?.destination || null),
    }));
  }
  return result;
}

function entityChanged(previous, next, now) {
  if (!previous) return true;
  const moved = Math.hypot((next.x || 0) - (previous.x || 0), (next.y || 0) - (previous.y || 0));
  const heading = Math.abs(((Number(next.heading) || 0) - (Number(previous.heading) || 0) + 540) % 360 - 180);
  const speed = Math.abs((Number(next.speed) || 0) - (Number(previous.speed) || 0));
  const structural = [
    "mode", "state", "active", "alive", "health", "hull", "engineHealth", "turretHealth",
    "targetPlayer", "equipped", "ammo", "pistolAmmo", "lockedTargetId", "activeBoat", "present",
    "phase", "repairSystem", "repairProgress", "repairPlates", "tacticalMode", "suppressionPhase",
  ].some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  return structural || moved >= 1.4 || heading >= 7 || speed >= 0.8 || now - (previous.loggedAt || 0) >= ENTITY_HEARTBEAT_MS;
}

function scanEntities(world) {
  const now = performance.now();
  const liveKeys = new Set();
  for (const snapshot of activeEntities(world)) {
    liveKeys.add(snapshot.key);
    const previous = state.entitySnapshots.get(snapshot.key);
    if (entityChanged(previous, snapshot, now)) {
      append(previous ? "entity-state" : "entity-spawned", {entity: snapshot});
      state.entitySnapshots.set(snapshot.key, {...snapshot, loggedAt: now});
    }
  }
  for (const [key, previous] of [...state.entitySnapshots.entries()]) {
    if (liveKeys.has(key)) continue;
    append("entity-removed", {
      entity: previous,
      reason: previous.kind.startsWith("enemy") || previous.kind === "heavy-boat" ? "destroyed-or-inactive" : "removed-or-sunk",
    });
    state.entitySnapshots.delete(key);
  }
}

function eventIdentity(event, occurrence) {
  return [
    round(event?.at, 3), event?.type || "unknown", event?.sourcePlayer ?? "", event?.targetPlayer ?? "",
    event?.targetId ?? "", event?.component ?? "", round(event?.x), round(event?.y), event?.text || "", occurrence,
  ].join("|");
}

function rememberEvent(id) {
  if (state.seenEventIds.has(id)) return false;
  state.seenEventIds.add(id);
  state.seenEventQueue.push(id);
  while (state.seenEventQueue.length > EVENT_MEMORY_LIMIT) {
    state.seenEventIds.delete(state.seenEventQueue.shift());
  }
  return true;
}

function scanEvents(world) {
  const occurrence = new Map();
  for (const event of world.events || []) {
    const base = eventIdentity(event, 0);
    const count = (occurrence.get(base) || 0) + 1;
    occurrence.set(base, count);
    const id = eventIdentity(event, count);
    if (rememberEvent(id)) append("game-event", {event});
  }
}

function scanInput() {
  const input = api()?.input;
  if (!input) return;
  const current = Object.fromEntries(ACTIVE_INPUT_KEYS.map(key => [key, input[key] ?? null]));
  if (!state.lastInput) {
    state.lastInput = current;
    append("input-state", {changes: current, initial: true});
    return;
  }
  const changes = {};
  for (const key of ACTIVE_INPUT_KEYS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(state.lastInput[key])) changes[key] = current[key];
  }
  if (Object.keys(changes).length) append("input-state", {changes});
  state.lastInput = current;
}

function networkSnapshot() {
  try { return api()?.networkDiagnostics?.() || null; }
  catch (_) { return null; }
}

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
    append("network-state", {network: current});
    state.lastNetworkAt = now;
  }
  state.lastNetwork = compactObject(current);
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
  };
  const serialized = JSON.stringify(summary);
  if (serialized !== state.lastWorldSummary) {
    state.lastWorldSummary = serialized;
    append("world-summary", {summary});
  }
}

function poll() {
  if (!state.enabled) return;
  try {
    scanInput();
    scanNetwork();
    const world = currentWorld();
    if (!world) return;
    scanEvents(world);
    scanEntities(world);
    scanWorldSummary(world);
  } catch (error) {
    append("logger-error", {message: error?.message || String(error), stack: error?.stack || null});
  }
}

function resetSession() {
  state.entries = [];
  state.droppedEntries = 0;
  state.sequence = 0;
  state.startedAt = new Date().toISOString();
  state.lastInput = null;
  state.lastNetwork = null;
  state.lastNetworkAt = 0;
  state.entitySnapshots.clear();
  state.seenEventIds.clear();
  state.seenEventQueue = [];
  state.lastWorldSummary = "";
  updateStatus();
}

function setEnabled(enabled) {
  const desired = Boolean(enabled);
  if (state.enabled === desired) return;
  state.enabled = desired;
  saveEnabled();
  if (desired) {
    resetSession();
    append("logger-enabled", {
      userAgent: navigator.userAgent,
      language: navigator.language,
      url: location.href,
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    });
    poll();
  } else {
    append("logger-disabled", {});
  }
  syncControls();
}

function fileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let room = "menu";
  try { room = api()?.roomId?.() || room; } catch (_) {}
  return `archipelago-debug-${room}-${stamp}.json`;
}

function download() {
  const payload = {
    format: "archipelago-developer-log-v1",
    startedAt: state.startedAt,
    exportedAt: new Date().toISOString(),
    enabled: state.enabled,
    droppedEntries: state.droppedEntries,
    entryCount: state.entries.length,
    entries: state.entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName();
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  append("log-downloaded", {entryCount: state.entries.length, bytes: blob.size});
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

function bindBrowserEvents() {
  window.addEventListener("keydown", event => {
    if (!state.enabled) return;
    append("keyboard", {action: "down", code: event.code, key: event.key, repeat: event.repeat, target: targetDescription(event.target)});
  }, true);
  window.addEventListener("keyup", event => {
    if (!state.enabled) return;
    append("keyboard", {action: "up", code: event.code, key: event.key, target: targetDescription(event.target)});
  }, true);
  for (const name of ["pointerdown", "pointerup", "click"]) {
    document.addEventListener(name, event => {
      if (!state.enabled) return;
      append("pointer", {
        action: name,
        pointerType: event.pointerType || null,
        pointerId: event.pointerId ?? null,
        button: event.button ?? null,
        buttons: event.buttons ?? null,
        clientX: round(event.clientX, 0),
        clientY: round(event.clientY, 0),
        target: targetDescription(event.target),
      });
    }, true);
  }
  document.addEventListener("visibilitychange", () => append("page-visibility", {hidden: document.hidden}));
  window.addEventListener("online", () => append("browser-network", {online: true}));
  window.addEventListener("offline", () => append("browser-network", {online: false}));
  window.addEventListener("focus", () => append("window-focus", {focused: true}));
  window.addEventListener("blur", () => append("window-focus", {focused: false}));
  window.addEventListener("error", event => append("javascript-error", {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || null,
  }));
  window.addEventListener("unhandledrejection", event => append("promise-rejection", {
    reason: event.reason?.stack || event.reason?.message || String(event.reason),
  }));

  const message = $("message");
  if (message) {
    new MutationObserver(() => {
      const text = String(message.textContent || "").trim();
      if (!state.enabled || !text || text === state.lastMessage) return;
      state.lastMessage = text;
      append("ui-message", {text});
    }).observe(message, {childList: true, characterData: true, subtree: true});
  }
}

function updateStatus() {
  const output = $("settingsDeveloperLogStatus");
  if (!output) return;
  output.textContent = state.entries.length
    ? `Записей: ${state.entries.length}${state.droppedEntries ? `. Старых удалено: ${state.droppedEntries}` : ""}.`
    : "Журнал пока пуст.";
  const downloadButton = $("settingsDeveloperDownloadButton");
  if (downloadButton) downloadButton.disabled = state.entries.length === 0;
}

function syncControls() {
  const toggle = $("settingsDeveloperLogButton");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(state.enabled));
    toggle.textContent = `Логирование всего: ${state.enabled ? "включено" : "выключено"}`;
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
  section.innerHTML = `
    <h3 id="developerSettingsTitle">Для разработчиков</h3>
    <div class="settings-grid">
      <button id="settingsDeveloperLogButton" aria-pressed="false">Логирование всего: выключено</button>
      <button id="settingsDeveloperDownloadButton">Скачать журнал</button>
      <button id="settingsDeveloperClearButton">Очистить журнал</button>
    </div>
    <p id="settingsDeveloperLogStatus" class="settings-note" aria-live="polite">Журнал пока пуст.</p>
    <p class="settings-note">Записываются нажатия и жесты, сетевые показатели, игровые события, состояния игроков, лодок и каждого живого врага. Координаты пишутся при движении и контрольными снимками; после уничтожения врага остаётся одна запись о его удалении.</p>
  `;
  card.insertBefore(section, close);
  $("settingsDeveloperLogButton")?.addEventListener("click", () => setEnabled(!state.enabled));
  $("settingsDeveloperDownloadButton")?.addEventListener("click", download);
  $("settingsDeveloperClearButton")?.addEventListener("click", () => {
    resetSession();
    if (state.enabled) append("log-cleared", {});
  });
  syncControls();
}

function install() {
  installSettingsGroup();
  bindBrowserEvents();
  clearInterval(state.timer);
  state.timer = setInterval(poll, POLL_INTERVAL_MS);
  if (state.enabled) {
    resetSession();
    append("logger-enabled", {
      restoredFromPreference: true,
      userAgent: navigator.userAgent,
      language: navigator.language,
      url: location.href,
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    });
  }
  poll();
}

install();

globalThis.__freeRoamDeveloperLog = {
  enable: () => setEnabled(true),
  disable: () => setEnabled(false),
  clear: resetSession,
  download,
  snapshot: () => ({
    enabled: state.enabled,
    entryCount: state.entries.length,
    droppedEntries: state.droppedEntries,
    startedAt: state.startedAt,
    entries: state.entries.slice(),
  }),
};
