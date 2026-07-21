"use strict";

import {
  WORLD,
  createFreeWorld,
  drainEvents,
  playerStatus,
  setPlayerInput,
  setPlayerPresence,
  snapshotWorld,
  stepFreeWorld,
} from "./free-roam-core-v6.js?v=40";
import {FreeRoamAudio} from "./free-roam-audio-v6.js?v=40";
import {createSpeechController} from "./free-roam-speech.js?v=39";
import {
  applyWorldDelta,
  compactWorldSnapshot,
  createReplicatedWorld,
  createWorldDelta,
} from "./free-roam-world-delta.js?v=40";
import {directionFromDelta} from "./free-roam-gesture-model.js";
import {classifyActionGesture, gestureMetrics} from "./free-roam-action-gestures.js";
import {resolveCombatTarget} from "./free-roam-targeting.js?v=32";
import {createTargetMenu} from "./free-roam-target-menu.js?v=32";

const $ = id => document.getElementById(id);
const SPEECH_RATE = 1.18;
const SNAPSHOT_INTERVAL_MS = 33;
const SNAPSHOT_BACKPRESSURE_BYTES = 24 * 1024;
const CHECKPOINT_INTERVAL_MS = 12_000;
const STATUS_RENDER_INTERVAL_MS = 100;
const AUDIO_RENDER_INTERVAL_MS = 32;
const CANVAS_RENDER_INTERVAL_MS = 32;
const movementNames = ["up", "down", "left", "right"];
const localInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
  pump: false,
  repair: false,
  action: false,
  jump: false,
  attack: false,
  weapon: false,
  sonar: false,
  guide: false,
  targetId: null,
};
const activeTouches = new Map();
const holdTimers = new Map();
const audio = new FreeRoamAudio();
let touchGroup = null;
let gestureDirection = null;
let gestureMode = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
const tapTimers = new Map();
const lastTapAt = new Map();
let roomRefreshTimer = 0;
let heartbeatTimer = 0;
let reconnectTimer = 0;
let leavingGame = false;
let preferredRoomId = "";
let socket = null;
let world = null;
let playerIndex = 0;
let isHost = false;
let roomId = "";
let previousFrame = 0;
let lastSnapshotAt = 0;
let lastAuthoritativeSnapshotAt = 0;
let lastCheckpointAt = 0;
let snapshotSequence = 0;
let lastSnapshotSequence = -1;
let networkBaseline = null;
let awaitingFullSnapshot = false;
let inputSequence = 0;
let lastRemoteInputSequence = 0;
let lastAcknowledgedInput = 0;
let lastStatusRenderAt = -Infinity;
let lastAudioRenderAt = -Infinity;
let lastCanvasRenderAt = -Infinity;
let controlLatencyMs = null;
let networkRttMs = null;
let latencyTimer = 0;
let latencyNonce = 0;
const inputSentAt = new Map();
const latencySentAt = new Map();
let lastInputSent = "";
let messageVersion = 0;

function distance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function resumeGameAudio() {
  if (audio?.ctx?.state === "suspended") audio.ctx.resume().catch(() => {});
}

const speech = createSpeechController({rate: SPEECH_RATE, onIdle: resumeGameAudio});

function readSpeechPreference() {
  try { return localStorage.getItem("echo-free-roam-speech") !== "off"; }
  catch (_) { return true; }
}

function syncSpeechButton() {
  const button = $("speechButton");
  if (!button) return;
  const pressed = String(speech.enabled);
  if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  const label = `Озвучка игры: ${speech.enabled ? "включена" : "выключена"}`;
  if (button.textContent !== label) button.textContent = label;
}

function setSpeechEnabled(enabled, report = true) {
  speech.setEnabled(enabled);
  try { localStorage.setItem("echo-free-roam-speech", speech.enabled ? "on" : "off"); } catch (_) {}
  syncSpeechButton();
  if (report) announce(`Озвучка игры ${speech.enabled ? "включена" : "выключена"}.`, true, speech.enabled);
}

function announce(text, assertive = false, spoken = true) {
  if (!text) return;
  $("message").textContent = text;
  const live = $("live");
  const version = ++messageVersion;
  live.setAttribute("aria-live", assertive ? "assertive" : "polite");
  live.textContent = "";
  requestAnimationFrame(() => {
    if (version === messageVersion) live.textContent = text;
  });
  if (spoken) speech.speak(text, {interrupt: assertive});
}

function socketUrl(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/connect`);
  url.searchParams.set("role", role);
  url.searchParams.set("mode", "free");
  if (role === "auto" && preferredRoomId) url.searchParams.set("room", preferredRoomId);
  return url.toString();
}

function send(payload, {dropIfBusy = false} = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (dropIfBusy && Number(socket.bufferedAmount) > SNAPSHOT_BACKPRESSURE_BYTES) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

function stopReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

function stopLatencyProbe() {
  clearInterval(latencyTimer);
  latencyTimer = 0;
  latencySentAt.clear();
}

function sendLatencyProbe() {
  const nonce = ++latencyNonce;
  latencySentAt.set(nonce, performance.now());
  while (latencySentAt.size > 6) latencySentAt.delete(latencySentAt.keys().next().value);
  send({type: "free-ping", nonce});
}

function startLatencyProbe() {
  stopLatencyProbe();
  sendLatencyProbe();
  latencyTimer = setInterval(sendLatencyProbe, 2_000);
}

function startHeartbeat() {
  stopHeartbeat();
  send({type: "heartbeat", at: Date.now()});
  heartbeatTimer = setInterval(() => send({type: "heartbeat", at: Date.now()}), 4_000);
}

function resetButtons() {
  $("hostButton").disabled = false;
  $("joinButton").disabled = false;
}

function openGame(text) {
  $("lobby").hidden = true;
  $("game").hidden = false;
  announce(text, true);
  requestAnimationFrame(() => $("gameTitle").focus({preventScroll: true}));
  previousFrame = performance.now();
  requestAnimationFrame(frame);
}

function reconnectSoloWorld(savedWorld) {
  if (leavingGame || reconnectTimer || $("game").hidden) return;
  announce("Связь с комнатой обновляется. Твой мир и лодка сохранены.", true);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (!leavingGame && !$("game").hidden) connect("captain", savedWorld);
  }, 900);
}

function connect(role, savedWorld = null) {
  audio.init().catch(() => {});
  speech.prime();
  stopReconnect();
  const requestedRole = role;
  const reconnecting = Boolean(savedWorld);
  isHost = requestedRole === "captain";
  playerIndex = isHost ? 0 : 1;
  $("hostButton").disabled = true;
  $("joinButton").disabled = true;
  announce(
    reconnecting
      ? "Восстанавливаю связь со свободным миром…"
      : requestedRole === "captain"
        ? "Создаю свободный мир…"
        : "Ищу свободный мир…",
  );

  const connection = new WebSocket(socketUrl(role));
  let lobbyReady = false;
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket === connection) startHeartbeat();
  });
  connection.addEventListener("message", event => {
    if (socket !== connection) return;
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (_) { return; }

    if (message.type === "lobby-ready") {
      lobbyReady = true;
      roomId = message.room || "";
      const actualRole = message.role || requestedRole;
      isHost = actualRole === "captain";
      playerIndex = isHost ? 0 : 1;
      $("roomLabel").textContent = `Свободный мир ${roomId}`;
      lastSnapshotSequence = -1;
      awaitingFullSnapshot = false;
      lastAcknowledgedInput = 0;
      inputSentAt.clear();
      if (isHost) {
        lastRemoteInputSequence = 0;
        networkBaseline = null;
        lastCheckpointAt = performance.now();
        const resumed = Boolean(message.resumeWorld);
        world = message.resumeWorld || savedWorld || createFreeWorld();
        setPlayerPresence(world, 0, true);
        setPlayerPresence(world, 1, Boolean(message.matched));
        const openedText = resumed
          ? "Мир восстановлен. Ты принял управление без сброса грузов, катеров и сценария."
          : message.matched
          ? "Свободный мир найден. Ты принял управление миром; второй игрок уже рядом."
          : requestedRole === "auto"
            ? message.replacedStale
              ? "Ожидавший мир уже закрылся до подключения. Создан новый мир; ждём второго игрока."
              : "Свободных миров не было. Создан новый мир; ждём второго игрока."
            : "Мир создан. Можно ездить одному; ждём второго игрока.";
        if ($("game").hidden) openGame(openedText);
        else announce("Связь восстановлена. Твой мир продолжает работать.", true);
        sendSnapshot(true);
        sendCheckpoint(performance.now(), true);
      } else if (!message.matched) {
        announce("Свободных миров не было. Создано место ожидания первого игрока.");
      } else {
        announce("Мир найден. Жду состояние бухты от первого игрока…");
        send({type: "free-hello"});
      }
      refreshRooms();
      if (message.matched) startLatencyProbe();
      return;
    }

    if (message.type === "peer-connected") {
      startLatencyProbe();
      if (isHost) {
        lastRemoteInputSequence = 0;
        if (world) setPlayerPresence(world, 1, true);
        announce("Второй игрок подключён к свободной бухте.", true);
        sendSnapshot(true);
      } else {
        lastSnapshotSequence = -1;
        awaitingFullSnapshot = true;
        announce("Первый игрок подключён. Загружаю бухту…", true);
        send({type: "free-hello"});
      }
      return;
    }

    if (message.type === "free-ping") {
      send({type: "free-pong", nonce: message.nonce});
      return;
    }

    if (message.type === "free-pong") {
      const startedAt = latencySentAt.get(Number(message.nonce));
      if (startedAt != null) {
        const sample = Math.max(0, performance.now() - startedAt);
        networkRttMs = networkRttMs == null ? sample : networkRttMs * 0.72 + sample * 0.28;
        latencySentAt.delete(Number(message.nonce));
      }
      return;
    }

    if (message.type === "free-hello" && isHost) {
      sendSnapshot(true);
      return;
    }

    if (message.type === "free-resync" && isHost) {
      sendSnapshot(true);
      return;
    }

    if (message.type === "free-input" && isHost && world) {
      const sequence = Math.max(0, Number(message.sequence) || 0);
      if (sequence && sequence <= lastRemoteInputSequence) return;
      if (sequence) lastRemoteInputSequence = sequence;
      setPlayerPresence(world, 1, true);
      setPlayerInput(world, 1, message.input || {});
      // Let the next animation frame apply the command before acknowledging it
      // in a snapshot. Forcing the pre-physics state caused a visible correction.
      lastSnapshotAt = -Infinity;
      return;
    }

    if (message.type === "free-snapshot" && !isHost) {
      const sequence = Number(message.sequence);
      if (Number.isFinite(sequence) && sequence <= lastSnapshotSequence) return;
      if (Number.isFinite(sequence)) lastSnapshotSequence = sequence;
      world = message.world;
      awaitingFullSnapshot = false;
      lastAuthoritativeSnapshotAt = performance.now();
      acknowledgeInput(message.ackInput);
      if ($("game").hidden) openGame("Ты вошёл в свободную бухту. У тебя отдельная лодка.");
      return;
    }

    if (message.type === "free-delta" && !isHost) {
      const sequence = Number(message.sequence);
      const expected = lastSnapshotSequence + 1;
      if (!world || awaitingFullSnapshot || !Number.isFinite(sequence)) return;
      if (sequence <= lastSnapshotSequence) return;
      if (sequence !== expected) {
        awaitingFullSnapshot = true;
        send({type: "free-resync", expected, received: sequence});
        return;
      }
      try {
        world = applyWorldDelta(world, message.delta ?? null);
      } catch (_) {
        awaitingFullSnapshot = true;
        send({type: "free-resync", expected, received: sequence});
        return;
      }
      lastSnapshotSequence = sequence;
      lastAuthoritativeSnapshotAt = performance.now();
      acknowledgeInput(message.ackInput);
      return;
    }

    if (message.type === "free-events") {
      for (const gameEvent of message.events || []) handleGameEvent(gameEvent);
      return;
    }

    if (message.type === "network-closed") {
      stopLatencyProbe();
      if (isHost && world) {
        lastRemoteInputSequence = 0;
        setPlayerPresence(world, 1, false);
        setPlayerInput(world, 1, {});
      }
      const waiting = message.waitingFor === "captain" ? "создателя мира" : "второго игрока";
      announce(`Игрок отключился. Комната сохранена и ждёт ${waiting}.`, true);
    }
  });

  connection.addEventListener("error", () => {
    if (socket !== connection || lobbyReady || !$("game").hidden) return;
    announce("Cloudflare Worker не открыл свободный мир. Обнови страницу и попробуй ещё раз.", true);
    resetButtons();
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    stopHeartbeat();
    stopLatencyProbe();
    const playingAlone = lobbyReady
      && isHost
      && world
      && !world.freeActivities?.presence?.[1];
    if (playingAlone && !leavingGame) reconnectSoloWorld(world);
    else if ($("game").hidden) resetButtons();
  });
}

function leaveGame() {
  leavingGame = true;
  stopReconnect();
  releaseAllMovement();
  stopHeartbeat();
  stopLatencyProbe();
  speech.cancel();
  audio.stopAll();
  socket?.close(1000, "leave");
  location.href = "/free-roam.html";
}

function acknowledgeInput(rawAcknowledged) {
  const acknowledged = Math.max(0, Number(rawAcknowledged) || 0);
  if (acknowledged <= lastAcknowledgedInput) return;
  const sentAt = inputSentAt.get(acknowledged);
  if (sentAt != null) {
    const sample = Math.max(0, performance.now() - sentAt);
    controlLatencyMs = controlLatencyMs == null ? sample : controlLatencyMs * 0.68 + sample * 0.32;
  }
  lastAcknowledgedInput = acknowledged;
  for (const sequenceNumber of [...inputSentAt.keys()]) {
    if (sequenceNumber <= acknowledged) inputSentAt.delete(sequenceNumber);
  }
}

function sendSnapshot(forceFull = false) {
  if (!isHost || !world) return;
  const now = performance.now();
  if (!forceFull && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  if (!forceFull && Number(socket?.bufferedAmount) > SNAPSHOT_BACKPRESSURE_BYTES) return;

  const sequence = snapshotSequence + 1;
  if (forceFull || !networkBaseline) {
    const fullWorld = compactWorldSnapshot(createReplicatedWorld(world));
    const sent = send({
      type: "free-snapshot",
      sequence,
      ackInput: lastRemoteInputSequence,
      world: fullWorld,
    });
    if (!sent) return;
    networkBaseline = fullWorld;
  } else {
    const delta = createWorldDelta(createReplicatedWorld(world), networkBaseline);
    const sent = send({
      type: "free-delta",
      sequence,
      ackInput: lastRemoteInputSequence,
      delta,
    }, {dropIfBusy: true});
    if (!sent) {
      // The diff updates its baseline in place. A failed send therefore needs
      // a fresh authoritative state rather than a delta with missing changes.
      networkBaseline = null;
      return;
    }
  }
  snapshotSequence = sequence;
  lastSnapshotAt = now;
}

function sendCheckpoint(now, force = false) {
  if (!isHost || !world || (!force && now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS)) return;
  if (!force && Number(socket?.bufferedAmount) > SNAPSHOT_BACKPRESSURE_BYTES) return;
  const sent = send({
    type: "free-checkpoint",
    world: compactWorldSnapshot(snapshotWorld(world)),
  }, {dropIfBusy: true});
  if (sent) lastCheckpointAt = now;
}

function sendInput(force = false) {
  if (isHost) {
    if (world) setPlayerInput(world, playerIndex, localInput);
    return;
  }
  const serialized = JSON.stringify(localInput);
  if (!force && serialized === lastInputSent) return;
  lastInputSent = serialized;
  const sequence = ++inputSequence;
  inputSentAt.set(sequence, performance.now());
  while (inputSentAt.size > 32) inputSentAt.delete(inputSentAt.keys().next().value);
  send({type: "free-input", sequence, input: localInput});
}

function opposite(name) {
  return {up: "down", down: "up", left: "right", right: "left"}[name] || null;
}

function setControl(name, active) {
  if (!(name in localInput)) return;
  const nextActive = Boolean(active);
  let changed = localInput[name] !== nextActive;
  if (active && movementNames.includes(name)) {
    const other = opposite(name);
    if (other && localInput[other]) {
      localInput[other] = false;
      changed = true;
    }
  }
  if (!changed) return false;
  localInput[name] = nextActive;
  sendInput(true);
  syncControlButtons();
  return true;
}

function toggleControl(name) {
  setControl(name, !localInput[name]);
}

function actionPulse(name, duration = 140) {
  setControl(name, true);
  clearTimeout(holdTimers.get(name));
  holdTimers.set(name, setTimeout(() => setControl(name, false), duration));
}

function releaseAllMovement() {
  for (const name of movementNames) localInput[name] = false;
  localInput.run = false;
  localInput.attack = false;
  localInput.action = false;
  localInput.jump = false;
  localInput.weapon = false;
  localInput.sonar = false;
  localInput.guide = false;
  for (const timer of holdTimers.values()) clearTimeout(timer);
  holdTimers.clear();
  activeTouches.clear();
  touchGroup = null;
  for (const timer of tapTimers.values()) clearTimeout(timer);
  tapTimers.clear();
  lastTapAt.clear();
  gestureDirection = null;
  sendInput(true);
}

function syncControlButtons() {
  setAttributeIfChanged($("pumpButton"), "aria-pressed", String(localInput.pump));
  setText($("pumpButton"), `Насос: ${localInput.pump ? "включён" : "выключен"}`);
  setAttributeIfChanged($("repairButton"), "aria-pressed", String(localInput.repair));
  setText($("repairButton"), `Пластина: ${localInput.repair ? "ставится" : "готова"}`);
  const guideActive = Boolean(world?.freeScenario?.guideEnabled?.[playerIndex]);
  setAttributeIfChanged($("guideButton"), "aria-pressed", String(guideActive));
  setText($("guideButton"), `Курс к сонару: ${guideActive ? "включён" : "выключен"}`);
}

function handleGameEvent(event) {
  audio.handleFreeEvent(event, playerIndex);
  if (!event?.targets?.includes(playerIndex)) return;
  if (
    targetMenu.isOpen()
    && ["player-knockdown", "player-death"].includes(event.type)
    && event.targetPlayer === playerIndex
  ) {
    targetMenu.close(false);
  }
  if (["target-lost", "target-cleared"].includes(event.type)) {
    localInput.targetId = null;
    sendInput(true);
  }
  if (["hull-repair-complete", "repair-blocked"].includes(event.type)) setControl("repair", false);
  if (!event.text) return;
  const critical = [
    "sink", "ram", "tow-detach", "flood-emergency-start", "flood-emergency-warning",
    "flood-emergency-failed", "engine-stall", "engine-flooded", "fuel-empty-ready",
    "player-knockdown-notice", "player-death",
  ].includes(event.type);
  if (targetMenu.isOpen() && !critical) return;
  announce(event.text, critical);
}

function stepInChunks(currentWorld, elapsedSeconds) {
  let remaining = Math.min(0.25, Math.max(0, elapsedSeconds));
  while (remaining > 0.0001) {
    const chunk = Math.min(0.05, remaining);
    stepFreeWorld(currentWorld, chunk);
    remaining -= chunk;
  }
}

function frame(now) {
  if ($("game").hidden) return;
  const dt = Math.max(0, (now - previousFrame) / 1000);
  previousFrame = now;
  if (isHost && world) {
    setPlayerInput(world, playerIndex, localInput);
    stepInChunks(world, dt);
    const events = drainEvents(world);
    for (const event of events) handleGameEvent(event);
    if (events.length) send({type: "free-events", events});
    sendSnapshot();
    sendCheckpoint(now);
  }
  render(now);
  requestAnimationFrame(frame);
}

function setText(element, value) {
  const text = String(value);
  if (element && element.textContent !== text) element.textContent = text;
}

function setAttributeIfChanged(element, name, value) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function render(now = performance.now()) {
  if (!world) return;
  const me = world.players[playerIndex];
  const other = world.players[1 - playerIndex];
  const myBoat = ["boat", "roof"].includes(me.mode) ? world.boats[me.activeBoat] : null;
  const labels = {boat: "в лодке", foot: "на берегу", swim: "в воде", roof: "на крыше", dead: "погиб"};
  const activities = world.freeActivities || {};
  const combat = me.combat || {};
  const marauder = activities.marauder || {};
  const pursuerSquad = world.freePursuerSquad || {};
  const activeEscorts = (pursuerSquad.escorts || []).filter(escort => escort.active && !escort.destroyed);
  const activePursuerCount = activeEscorts.length + (marauder.active && !marauder.destroyed ? 1 : 0);
  const activeGunners = (world.freeHostileGunners?.gunners || []).filter(gunner => gunner.active && !gunner.destroyed);
  const sonarPursuer = world.freeScenario?.targets?.[playerIndex]?.kind === "pursuer"
    ? [marauder, ...activeEscorts].find(pursuer => pursuer.id === world.freeScenario.targets[playerIndex].id)
    : null;
  const weaponLabels = {fists: "кулаки", knife: "нож", automatic: "автомат"};
  const lockedCombatTarget = resolveCombatTarget(world, playerIndex, combat.lockedTargetId, 420);
  if (now - lastStatusRenderAt >= STATUS_RENDER_INTERVAL_MS) {
    lastStatusRenderAt = now;
    setText($("modeValue"), combat.knockedDown ? "сбит с ног" : labels[me.mode] || me.mode);
    setText($("speedValue"), combat.knockedDown ? "оглушён" : myBoat ? Math.abs(myBoat.speed).toFixed(1) : me.mode === "swim" ? "плывёт" : me.running ? "бежит" : "идёт");
    setText($("hullValue"), myBoat ? `${Math.round(myBoat.hull)}%` : "—");
    setText($("waterValue"), myBoat ? `${Math.round(myBoat.water)}%` : "—");
    setText($("towValue"), !world.tow ? "нет" : world.tow.towerBoat === me.activeBoat ? "тащишь" : world.tow.towedBoat === me.activeBoat ? "тебя тащат" : "рядом");
    setText($("otherValue"), activities.presence?.[1 - playerIndex] ? `${Math.round(distance(me, other))} м` : "ждём");
    setText($("healthValue"), combat.alive === false
      ? `возрождение ${Math.ceil(combat.respawnRemaining || 0)} с`
      : combat.knockedDown
        ? `${Math.round(combat.health ?? 100)}%, оглушён`
        : `${Math.round(combat.health ?? 100)}%`);
    setText($("weaponValue"), combat.equipped === "automatic" ? `автомат, ${combat.ammo || 0}` : weaponLabels[combat.equipped] || "кулаки");
    setText($("targetValue"), lockedCombatTarget?.label || "не выбрана");
    setText($("cargoValue"), combat.carriedCrate ? "в руках" : myBoat?.cargo?.length ? `${myBoat.cargo.length}, вес ${Math.round(myBoat.cargoWeight || 0)}` : "нет");
    setText($("scoreValue"), String(activities.score?.[playerIndex] || 0));
    setText($("scenarioValue"), {
      salvage: "доставка",
      arm: "поиск автомата",
      warning: "предупреждение",
      pursuit: "погоня",
      victory: "пройден",
    }[world.freeScenario?.phase] || "доставка");
    setText($("marauderValue"), activePursuerCount
      ? `${activePursuerCount} катера; стрелков ${activeGunners.length}; цель ${Math.round(sonarPursuer?.hull ?? marauder.hull ?? 0)}%; пуль ${(pursuerSquad.projectiles || []).length + (world.freeHostileGunners?.projectiles || []).length}`
      : world.freeScenario?.phase === "victory"
        ? "все уничтожены"
        : "ещё не появились");
    const connectionParts = [];
    if (networkRttMs != null) connectionParts.push(`сеть ${Math.round(networkRttMs)} мс`);
    if (controlLatencyMs != null && !isHost) connectionParts.push(`управление ${Math.round(controlLatencyMs)} мс`);
    setText($("networkValue"), connectionParts.join(", ") || (activities.presence?.[1 - playerIndex] ? "измеряю" : "ждём игрока"));
  }
  setText($("actionButton"), combat.knockedDown
    ? "Сбит с ног — жди"
    : combat.carriedCrate
      ? "Положить / передать / погрузить"
      : me.mode === "boat"
        ? "Груз / выйти / буксир"
        : me.mode === "roof"
          ? "Груз / сесть за руль"
          : "Взять груз / сесть в лодку");
  setText($("jumpButton"), me.mode === "boat" ? "Плавучий тормоз" : me.mode === "roof" ? "Спрыгнуть" : "Прыжок / крыша");
  setText($("attackButton"), combat.equipped === "automatic" ? "Огонь" : combat.equipped === "knife" ? "Удар ножом" : "Удар");
  setText($("weaponButton"), `Оружие: ${weaponLabels[combat.equipped] || "кулаки"}`);
  setAttributeIfChanged($("targetButton"), "aria-pressed", String(targetMenu.isOpen()));
  setText($("targetButton"), targetMenu.isOpen() ? "Выбор цели открыт" : "Выбрать цель");
  syncControlButtons();
  if (now - lastAudioRenderAt >= AUDIO_RENDER_INTERVAL_MS) {
    lastAudioRenderAt = now;
    audio.updateWorld(world, playerIndex);
  }
  if (!document.hidden && now - lastCanvasRenderAt >= CANVAS_RENDER_INTERVAL_MS) {
    lastCanvasRenderAt = now;
    drawMap(world);
  }
}

function drawMap(currentWorld) {
  const canvas = $("map");
  const ctx = canvas.getContext("2d");
  const sx = canvas.width / WORLD.width;
  const sy = canvas.height / WORLD.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0b4051";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#435b3a";
  const landMinX = (WORLD.landMinX ?? 0) * sx;
  const landWidth = ((WORLD.landMaxX ?? WORLD.width) - (WORLD.landMinX ?? 0)) * sx;
  const landMinY = (WORLD.landMinY ?? 0) * sy;
  const landHeight = ((WORLD.landMaxY ?? WORLD.shoreY) - (WORLD.landMinY ?? 0)) * sy;
  ctx.fillRect(landMinX, landMinY, landWidth, landHeight);
  ctx.fillStyle = "#77836a";
  ctx.fillRect(WORLD.dockMinX * sx, (WORLD.shoreY - 8) * sy, (WORLD.dockMaxX - WORLD.dockMinX) * sx, 18 * sy);

  if (currentWorld.tow) {
    const tower = currentWorld.boats[currentWorld.tow.towerBoat];
    const towed = currentWorld.boats[currentWorld.tow.towedBoat];
    ctx.strokeStyle = currentWorld.tow.tension > 0.7 ? "#ffb2a7" : "#e9dcaa";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tower.x * sx, tower.y * sy);
    ctx.lineTo(towed.x * sx, towed.y * sy);
    ctx.stroke();
  }

  for (const boat of currentWorld.boats) {
    ctx.save();
    ctx.translate(boat.x * sx, boat.y * sy);
    ctx.rotate(boat.heading * Math.PI / 180);
    ctx.fillStyle = boat.sunk ? "#4f5c60" : boat.driver === playerIndex ? "#7ee8ff" : "#f3c66b";
    ctx.fillRect(-7, -14, 14, 28);
    ctx.restore();
  }

  for (const player of currentWorld.players) {
    if (player.mode === "boat" || player.mode === "dead") continue;
    ctx.fillStyle = player.id === playerIndex ? "#ffffff" : "#ffdc7e";
    ctx.beginPath();
    ctx.arc(player.x * sx, player.y * sy, player.mode === "roof" ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const crate of currentWorld.freeActivities?.crates || []) {
    if (crate.state !== "world") continue;
    ctx.fillStyle = crate.rarity === "rare" ? "#ffcc4d" : "#d9b77d";
    ctx.fillRect(crate.x * sx - 4, crate.y * sy - 4, 8, 8);
  }

  const marauder = currentWorld.freeActivities?.marauder;
  if (marauder?.active && !marauder.destroyed) {
    ctx.save();
    ctx.translate(marauder.x * sx, marauder.y * sy);
    ctx.rotate(marauder.heading * Math.PI / 180);
    ctx.fillStyle = "#d85c4a";
    ctx.fillRect(-8, -15, 16, 30);
    ctx.restore();
  }
  for (const escort of currentWorld.freePursuerSquad?.escorts || []) {
    if (!escort.active || escort.destroyed) continue;
    ctx.save();
    ctx.translate(escort.x * sx, escort.y * sy);
    ctx.rotate(escort.heading * Math.PI / 180);
    ctx.fillStyle = "#f06a52";
    ctx.fillRect(-7, -14, 14, 28);
    ctx.restore();
  }
  for (const projectile of currentWorld.freePursuerSquad?.projectiles || []) {
    ctx.fillStyle = "#fff2a8";
    ctx.beginPath();
    ctx.arc(projectile.x * sx, projectile.y * sy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const gunner of currentWorld.freeHostileGunners?.gunners || []) {
    if (!gunner.active || gunner.destroyed) continue;
    ctx.fillStyle = "#ff8e72";
    ctx.beginPath();
    ctx.arc(gunner.x * sx, gunner.y * sy, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const projectile of currentWorld.freeHostileGunners?.projectiles || []) {
    ctx.fillStyle = "#ffd49a";
    ctx.beginPath();
    ctx.arc(projectile.x * sx, projectile.y * sy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function setGestureMode(enabled, announceChange = true) {
  gestureMode = Boolean(enabled);
  document.body.classList.toggle("gesture-mode", gestureMode);
  $("controlModeButton").setAttribute("aria-pressed", String(gestureMode));
  $("controlModeButton").textContent = `Управление: ${gestureMode ? "жесты" : "кнопки"}`;
  if (!gestureMode) releaseGestureDirection();
  if (announceChange) announce(gestureMode ? "Включены жесты. Игровые кнопки скрыты." : "Включены кнопки. Игровые жесты отключены.");
}

function showButtonsForAssistiveInput() {
  if (!gestureMode) document.body.classList.remove("gesture-mode");
}

function bindHold(button, name, minimumDuration = 0) {
  const startedAt = new Map();
  let releaseTimer = 0;
  const down = event => {
    if (event.pointerType === "touch") showButtonsForAssistiveInput();
    event.preventDefault();
    audio.init().catch(() => {});
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    startedAt.set(event.pointerId, performance.now());
    setControl(name, true);
    button.setPointerCapture?.(event.pointerId);
  };
  const finish = (event, cancelled = false) => {
    const started = startedAt.get(event.pointerId);
    if (started == null) return;
    startedAt.delete(event.pointerId);
    event.preventDefault();
    const remaining = cancelled ? 0 : Math.max(0, minimumDuration - (performance.now() - started));
    if (remaining > 0) releaseTimer = setTimeout(() => {
      releaseTimer = 0;
      setControl(name, false);
    }, remaining);
    else setControl(name, false);
  };
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", event => finish(event));
  button.addEventListener("pointercancel", event => finish(event, true));
  button.addEventListener("lostpointercapture", event => finish(event, true));
}

function applyGestureDirection(direction) {
  if (!gestureMode) return;
  if (direction === gestureDirection) return;
  if (gestureDirection) setControl(gestureDirection, false);
  gestureDirection = direction;
  if (gestureDirection) {
    setControl(gestureDirection, true);
  }
}

function releaseGestureDirection() {
  if (gestureDirection) setControl(gestureDirection, false);
  gestureDirection = null;
}

function beginTouch(event) {
  if (!gestureMode || event.pointerType !== "touch" || event.target.closest("button, a, summary, input, textarea, select")) return;
  event.preventDefault();
  audio.init().catch(() => {});
  const point = {x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY};
  activeTouches.set(event.pointerId, point);
  if (!touchGroup) touchGroup = {startedAt: performance.now(), points: new Map(), maxPointers: 0};
  touchGroup.points.set(event.pointerId, point);
  touchGroup.maxPointers = Math.max(touchGroup.maxPointers, activeTouches.size);
  if (touchGroup.maxPointers > 1) releaseGestureDirection();
  $("game").setPointerCapture?.(event.pointerId);
}

function moveTouch(event) {
  const point = activeTouches.get(event.pointerId);
  if (!point) return;
  event.preventDefault();
  point.lastX = event.clientX;
  point.lastY = event.clientY;
  if (targetMenu.isOpen()) return;
  if (!touchGroup || touchGroup.maxPointers !== 1 || activeTouches.size !== 1) return;
  const deltaX = point.lastX - point.x;
  const deltaY = point.lastY - point.y;
  const direction = directionFromDelta(deltaX, deltaY, 26);
  if (direction) applyGestureDirection(direction);
  const longSwipe = Math.hypot(deltaX, deltaY) >= 125;
  const onFoot = world?.players?.[playerIndex]?.mode === "foot";
  const shouldRun = Boolean(longSwipe && onFoot);
  if (localInput.run !== shouldRun) setControl("run", shouldRun);
}

function runGestureCommand(command) {
  if (!command) return;
  audio.init().catch(() => {});
  if (command === "action") actionPulse("action");
  else if (command === "jump") actionPulse("jump");
  else if (command === "attack-light") actionPulse("attack", 140);
  else if (command === "attack-heavy") actionPulse("attack", 680);
  else if (command === "weapon") actionPulse("weapon");
  else if (command === "sonar") actionPulse("sonar");
  else if (command === "guide") actionPulse("guide");
  else if (command === "targets") targetMenu.open();
  else if (command === "pump") {
    toggleControl("pump");
    announce(`Насос ${localInput.pump ? "включён" : "выключен"}.`);
  } else if (command === "repair") {
    if (!localInput.repair) setControl("repair", true);
    announce("Заделка пробоины началась.");
  } else if (command === "status") {
    if (world) announce(playerStatus(world, playerIndex), true);
  } else if (command === "buttons") {
    setGestureMode(false);
  }
}

function runTapGesture(metrics) {
  const pointers = Math.max(1, Number(metrics.pointers) || 1);
  const now = performance.now();
  const previous = lastTapAt.get(pointers) || 0;
  if (previous && now - previous <= 310) {
    clearTimeout(tapTimers.get(pointers));
    tapTimers.delete(pointers);
    lastTapAt.delete(pointers);
    runGestureCommand(classifyActionGesture({...metrics, taps: 2}));
    return;
  }
  lastTapAt.set(pointers, now);
  clearTimeout(tapTimers.get(pointers));
  tapTimers.set(pointers, setTimeout(() => {
    lastTapAt.delete(pointers);
    tapTimers.delete(pointers);
    runGestureCommand(classifyActionGesture({...metrics, taps: 1}));
  }, 315));
}

function finishTouch(event, cancelled = false) {
  const point = activeTouches.get(event.pointerId);
  if (!point) return;
  event.preventDefault?.();
  point.lastX = event.clientX ?? point.lastX;
  point.lastY = event.clientY ?? point.lastY;
  activeTouches.delete(event.pointerId);
  if (activeTouches.size > 0) return;

  const group = touchGroup;
  touchGroup = null;
  releaseGestureDirection();
  if (localInput.run) setControl("run", false);
  if (cancelled || !group) return;
  const metrics = gestureMetrics(group);
  if (targetMenu.isOpen()) {
    if (metrics.pointers === 1 && metrics.movement > 24) {
      targetMenu.cycle(metrics.dy < 0 ? -1 : 1);
    } else if (metrics.pointers === 1) {
      targetMenu.confirm();
    } else {
      targetMenu.close(true);
    }
    return;
  }
  if (metrics.pointers <= 3 && metrics.movement <= 24 && metrics.duration < 520) runTapGesture(metrics);
  else runGestureCommand(classifyActionGesture(metrics));
}

function bindGestures() {
  const surface = $("game");
  surface.addEventListener("pointerdown", beginTouch, {passive: false});
  surface.addEventListener("pointermove", moveTouch, {passive: false});
  surface.addEventListener("pointerup", event => finishTouch(event, false), {passive: false});
  surface.addEventListener("pointercancel", event => finishTouch(event, true), {passive: false});
}

function bindKeyboard() {
  const map = {ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right"};
  window.addEventListener("keydown", event => {
    if ($("game").hidden || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.target.matches("input, textarea, select, [contenteditable='true']")) return;
    if (!event.repeat && event.code === "KeyM") {
      event.preventDefault();
      if (targetMenu.isOpen()) targetMenu.close(true);
      else targetMenu.open();
      audio.init().catch(() => {});
      return;
    }
    if (targetMenu.isOpen()) {
      if (!event.repeat && event.code === "ArrowUp") targetMenu.cycle(-1);
      else if (!event.repeat && event.code === "ArrowDown") targetMenu.cycle(1);
      else if (!event.repeat && event.code === "Enter") targetMenu.confirm();
      else if (!event.repeat && event.code === "Escape") targetMenu.close(true);
      else if (!event.code.startsWith("Arrow")) return;
      event.preventDefault();
      audio.init().catch(() => {});
      return;
    }
    const movement = map[event.code] || map[event.key];
    if (event.repeat && (movement || ["ShiftLeft", "ShiftRight", "KeyX"].includes(event.code))) {
      event.preventDefault();
      return;
    }
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      event.preventDefault();
      setControl("run", true);
    } else if (movement) {
      event.preventDefault();
      setControl(movement, true);
    } else if (!event.repeat && event.code === "KeyF") {
      event.preventDefault();
      actionPulse("action");
    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      actionPulse("jump");
    } else if (event.code === "KeyX") {
      event.preventDefault();
      setControl("attack", true);
    } else if (!event.repeat && event.code === "KeyZ") {
      event.preventDefault();
      actionPulse("weapon");
    } else if (!event.repeat && event.code === "KeyC") {
      event.preventDefault();
      toggleControl("pump");
      announce(`Насос ${localInput.pump ? "включён" : "выключен"}.`);
    } else if (!event.repeat && event.code === "KeyV") {
      event.preventDefault();
      toggleControl("repair");
    } else if (!event.repeat && event.code === "KeyQ") {
      event.preventDefault();
      actionPulse("sonar");
    } else if (!event.repeat && event.code === "KeyY") {
      event.preventDefault();
      actionPulse("guide");
    } else return;
    audio.init().catch(() => {});
  }, true);

  window.addEventListener("keyup", event => {
    if (event.code === "KeyX") {
      event.preventDefault();
      setControl("attack", false);
      return;
    }
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      event.preventDefault();
      setControl("run", false);
      return;
    }
    const movement = map[event.code] || map[event.key];
    if (!movement) return;
    event.preventDefault();
    setControl(movement, false);
  }, true);

  window.addEventListener("blur", releaseAllMovement);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllMovement();
  });
}

async function refreshRooms() {
  try {
    const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    preferredRoomId = rooms[0]?.id || "";
    if (!rooms.length) {
      $("roomsSummary").textContent = "Сейчас нет ожидающих миров. Кнопка входа создаст новый мир.";
    } else if (rooms[0].waitingFor === "captain") {
      $("roomsSummary").textContent = `Миров: ${rooms.length}. Ближайший ждёт создателя; кнопка входа займёт его место.`;
    } else {
      $("roomsSummary").textContent = `Миров: ${rooms.length}. Ближайший ждёт второго игрока.`;
    }
    $("roomsList").replaceChildren(...rooms.map((room, index) => {
      const item = document.createElement("li");
      item.textContent = `Мир ${index + 1}: ждёт ${room.waitingFor === "captain" ? "создателя мира" : "второго игрока"}, ${room.ageSeconds} с.`;
      return item;
    }));
  } catch (error) {
    $("roomsSummary").textContent = `Сервер свободных миров не отвечает: ${error.message}.`;
    $("roomsList").replaceChildren();
  }
}

const targetMenu = createTargetMenu({
  getWorld: () => world,
  getPlayerIndex: () => playerIndex,
  getTargetId: () => localInput.targetId,
  setTargetId: value => { localInput.targetId = value; },
  releaseMovement: releaseAllMovement,
  sendInput: () => sendInput(true),
  announce,
  render,
});

document.addEventListener("pointerdown", () => speech.prime(), {capture: true});
document.addEventListener("keydown", () => speech.prime(), {capture: true});

$("hostButton").addEventListener("click", () => connect("captain"));
$("joinButton").addEventListener("click", () => connect("auto"));
$("refreshButton").addEventListener("click", refreshRooms);
$("leaveButton").addEventListener("click", leaveGame);
$("speechButton").addEventListener("click", () => setSpeechEnabled(!speech.enabled));
$("statusButton").addEventListener("click", () => {
  if (world) announce(playerStatus(world, playerIndex), true);
});
$("controlModeButton").addEventListener("click", () => setGestureMode(!gestureMode));
bindHold($("upButton"), "up");
bindHold($("downButton"), "down");
bindHold($("leftButton"), "left");
bindHold($("rightButton"), "right");
$("actionButton").addEventListener("click", () => actionPulse("action"));
$("jumpButton").addEventListener("click", () => actionPulse("jump"));
bindHold($("attackButton"), "attack", 90);
$("attackButton").addEventListener("click", event => {
  if (event.detail === 0) actionPulse("attack");
});
$("weaponButton").addEventListener("click", () => actionPulse("weapon"));
$("targetButton").addEventListener("click", () => {
  if (targetMenu.isOpen()) targetMenu.close(true);
  else targetMenu.open();
});
$("sonarButton").addEventListener("click", () => actionPulse("sonar"));
$("guideButton").addEventListener("click", () => actionPulse("guide"));
$("pumpButton").addEventListener("click", () => toggleControl("pump"));
$("repairButton").addEventListener("click", () => toggleControl("repair"));
bindGestures();
bindKeyboard();
setSpeechEnabled(readSpeechPreference(), false);
setGestureMode(gestureMode, false);
syncControlButtons();
refreshRooms();
roomRefreshTimer = setInterval(() => {
  if (!$("lobby").hidden) refreshRooms();
}, 5000);

window.__freeRoam = {
  getWorld: () => world,
  setWorld: value => { world = value; render(); },
  setPlayerIndex: value => { playerIndex = Number(value) || 0; render(); },
  input: localInput,
  setControl,
  step: seconds => { if (world) { stepFreeWorld(world, seconds); render(); } },
  status: () => world && playerStatus(world, playerIndex),
  gestureDirection: () => gestureDirection,
  isHost: () => isHost,
  playerIndex: () => playerIndex,
  audioDiagnostics: () => globalThis.__freeRoamAudioDiagnostics || null,
  speechDiagnostics: () => ({
    available: speech.available,
    enabled: speech.enabled,
    activeText: speech.activeText,
    pendingText: speech.pendingText,
    voice: speech.voice?.name || null,
  }),
  networkDiagnostics: () => ({
    networkRttMs,
    controlLatencyMs,
    snapshotSequence: lastSnapshotSequence,
    socketBufferedAmount: Number(socket?.bufferedAmount) || 0,
  }),
  roomId: () => roomId,
  preferredRoom: () => preferredRoomId,
  handleEvent: event => handleGameEvent(event),
  targeting: targetMenu.snapshot,
};
