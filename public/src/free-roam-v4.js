"use strict";

import {
  WORLD,
  playerStatus,
} from "./free-roam-core-v6.js?v=42";
import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=42";
import {predictLocalWorld, reconcileLocalPrediction} from "./free-roam-client-prediction.js?v=40";
import {applyReplicatedWorldDelta} from "./free-roam-replication.js?v=44";
import {createSpeechController} from "./free-roam-speech.js?v=41";
import {directionFromDelta} from "./free-roam-gesture-model.js";
import {classifyActionGesture, gestureMetrics} from "./free-roam-action-gestures.js";
import {resolveCombatTarget} from "./free-roam-targeting.js?v=34";
import {createTargetMenu} from "./free-roam-target-menu.js?v=34";
import {MERCHANT, SHOP_ITEMS} from "./free-roam-shop.js?v=1";
import {CONTRACT_BOARD} from "./free-roam-contracts.js?v=2";
import {cargoDefinition} from "./free-roam-contract-catalog.js?v=1";

const $ = id => document.getElementById(id);
const SPEECH_RATE = 1.18;
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
  navigationTargetId: "objective",
  shopPrevious: false,
  shopNext: false,
  shopBuy: false,
  shopClose: false,
  boardPrevious: false,
  boardNext: false,
  boardAccept: false,
  boardClose: false,
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
let reconnectAttempt = 0;
let reconnectInProgress = false;
let reconnectLongNoticeSpoken = false;
let reconnectRole = "";
let reconnectRoom = "";
let leavingGame = false;
let preferredRoomId = "";
let socket = null;
let world = null;
let authoritativeWorld = null;
let playerIndex = 0;
let isHost = false;
let roomId = "";
let previousFrame = 0;
let lastInputSent = "";
let lastStateSequence = 0;
let receivedStateCount = 0;
let lastStateAt = 0;
let lastRenderAt = -Infinity;
let inputSequence = 0;
let networkRttMs = null;
let inputReceiptMs = null;
let controlLatencyMs = null;
let latencyNonce = 0;
let latencyTimer = 0;
const latencySentAt = new Map();
const inputSentAt = new Map();
let messageVersion = 0;

function distance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function shopIsOpen() {
  return Boolean(world?.freeActivities?.shopOpen?.[playerIndex]);
}

function boardIsOpen() {
  return Boolean(world?.freeContracts?.boardOpen?.[playerIndex]);
}

function selectedBoardEntry() {
  const state = world?.freeContracts;
  if (!state) return null;
  const entries = state.activeContract
    ? [{label: `Текущий заказ: ${state.activeContract.label}`}, {label: "Отказаться от заказа"}]
    : (state.offerIds || []).map(id => cargoDefinition(id)).filter(Boolean);
  const raw = Number(state.boardSelection?.[playerIndex]) || 0;
  return entries[((raw % entries.length) + entries.length) % entries.length] || null;
}

function nearContractBoard() {
  const player = world?.players?.[playerIndex];
  return Boolean(player?.mode === "foot" && distance(player, CONTRACT_BOARD) <= 8.5);
}

function selectedShopItem() {
  const index = Number(world?.freeActivities?.shopSelection?.[playerIndex]) || 0;
  return SHOP_ITEMS[((index % SHOP_ITEMS.length) + SHOP_ITEMS.length) % SHOP_ITEMS.length] || SHOP_ITEMS[0];
}

function nearMerchant() {
  const player = world?.players?.[playerIndex];
  return Boolean(player?.mode === "foot" && distance(player, MERCHANT) <= 9);
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
  button.setAttribute("aria-pressed", String(speech.enabled));
  button.textContent = `Озвучка игры: ${speech.enabled ? "включена" : "выключена"}`;
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

function socketUrl(role, targetRoom = "") {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/connect`);
  url.searchParams.set("role", role);
  url.searchParams.set("mode", "free");
  const requestedRoom = targetRoom || (role === "auto" ? preferredRoomId : "");
  if (requestedRoom) url.searchParams.set("room", requestedRoom);
  return url.toString();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

const RECONNECT_DELAYS_MS = Object.freeze([400, 900, 1_600, 2_800, 4_500, 7_000, 10_000]);

function stopReconnectTimer() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

function resetReconnectState() {
  stopReconnectTimer();
  reconnectAttempt = 0;
  reconnectInProgress = false;
  reconnectLongNoticeSpoken = false;
  reconnectRole = "";
  reconnectRoom = "";
}

function stopLatencyProbe() {
  clearInterval(latencyTimer);
  latencyTimer = 0;
  latencySentAt.clear();
}

function sendLatencyProbe() {
  const nonce = ++latencyNonce;
  latencySentAt.set(nonce, performance.now());
  while (latencySentAt.size > 8) latencySentAt.delete(latencySentAt.keys().next().value);
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

function reconnectToRoom(role, targetRoom) {
  if (leavingGame || reconnectTimer || $("game").hidden || !targetRoom) return;
  reconnectRole = role;
  reconnectRoom = targetRoom;
  if (!reconnectInProgress) {
    reconnectInProgress = true;
    reconnectAttempt = 0;
    reconnectLongNoticeSpoken = false;
    releaseAllMovement();
    announce("Связь с Cloudflare прервалась. Восстанавливаю тот же мир.", true);
  } else if (reconnectAttempt >= 6 && !reconnectLongNoticeSpoken) {
    reconnectLongNoticeSpoken = true;
    announce("Связь пока не восстановлена. Продолжаю попытки без повторных сообщений.", true);
  }
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (leavingGame || $("game").hidden) return;
    reconnectAttempt += 1;
    connect(reconnectRole, {reconnecting: true, targetRoom: reconnectRoom});
  }, delay);
}

function connect(role, {reconnecting = false, targetRoom = ""} = {}) {
  audio.init().catch(() => {});
  speech.prime();
  stopReconnectTimer();
  const requestedRole = role;
  isHost = requestedRole === "captain";
  playerIndex = isHost ? 0 : 1;
  $("hostButton").disabled = true;
  $("joinButton").disabled = true;
  if (reconnecting) {
    $("message").textContent = `Восстанавливаю связь, попытка ${reconnectAttempt}.`;
  } else {
    announce(requestedRole === "captain" ? "Создаю свободный мир…" : "Ищу свободный мир…");
  }

  const connection = new WebSocket(socketUrl(role, targetRoom));
  let lobbyReady = false;
  let connectionDeadline = setTimeout(() => {
    if (socket === connection && !lobbyReady) {
      try { connection.close(4103, "connection-timeout"); } catch (_) {}
    }
  }, reconnecting ? 6_000 : 10_000);
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket === connection) {
      startHeartbeat();
      startLatencyProbe();
    }
  });
  connection.addEventListener("message", event => {
    if (socket !== connection) return;
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (_) { return; }

    if (message.type === "lobby-ready") {
      const actualRole = message.role || requestedRole;
      const wrongReconnectRoom = reconnecting && targetRoom && (
        message.room !== targetRoom
        || actualRole !== requestedRole
        || message.preferredRoomFound !== true
      );
      if (wrongReconnectRoom) {
        try { connection.close(4101, "wrong-reconnect-room"); } catch (_) {}
        return;
      }
      clearTimeout(connectionDeadline);
      connectionDeadline = 0;
      lobbyReady = true;
      roomId = message.room || "";
      isHost = actualRole === "captain";
      playerIndex = isHost ? 0 : 1;
      lastStateSequence = 0;
      authoritativeWorld = null;
      inputSentAt.clear();
      $("roomLabel").textContent = `Свободный мир ${roomId}`;
      if (reconnecting) {
        resetReconnectState();
        announce("Связь восстановлена. Ты снова в прежнем мире.", true);
      } else {
        announce(message.matched
          ? "Свободный мир найден. Сервер Cloudflare загружает состояние бухты…"
          : isHost
            ? "Свободный мир создан на сервере Cloudflare. Можно играть одному; ждём второго игрока."
            : "Создано место ожидания первого игрока. Сервер Cloudflare сохранит единое состояние мира.");
      }
      sendInput(true);
      refreshRooms();
      return;
    }

    if (message.type === "peer-connected") {
      announce(isHost ? "Второй игрок подключён к свободной бухте." : "Первый игрок подключён.", true);
      return;
    }

    if (message.type === "free-pong") {
      const sentAt = latencySentAt.get(Number(message.nonce));
      if (sentAt != null) {
        const sample = Math.max(0, performance.now() - sentAt);
        networkRttMs = networkRttMs == null ? sample : networkRttMs * 0.72 + sample * 0.28;
        latencySentAt.delete(Number(message.nonce));
      }
      return;
    }

    if (message.type === "free-input-received") {
      const sequence = Math.max(0, Number(message.sequence) || 0);
      const sentAt = inputSentAt.get(sequence);
      if (sentAt != null) {
        const sample = Math.max(0, performance.now() - sentAt);
        inputReceiptMs = inputReceiptMs == null ? sample : inputReceiptMs * 0.68 + sample * 0.32;
      }
      return;
    }

    if (message.type === "free-state") {
      receivedStateCount += 1;
      const sequence = Math.max(0, Number(message.sequence) || 0);
      if (sequence <= lastStateSequence) {
        send({type: "free-state-ack", sequence});
        return;
      }
      const nextAuthoritative = message.full === false
        ? applyReplicatedWorldDelta(authoritativeWorld, message.delta)
        : message.world;
      if (!nextAuthoritative) {
        send({type: "free-resync"});
        return;
      }
      authoritativeWorld = nextAuthoritative;
      const previousWorld = world;
      const renderWorld = typeof structuredClone === "function"
        ? structuredClone(authoritativeWorld)
        : JSON.parse(JSON.stringify(authoritativeWorld));
      world = reconcileLocalPrediction(previousWorld, renderWorld, playerIndex);
      lastStateSequence = sequence;
      lastStateAt = performance.now();
      // Acknowledge before speech, audio or rendering. Even if an assistive
      // technology blocks the main thread afterward, the server will retain
      // only one newer state instead of building a stale queue.
      send({type: "free-state-ack", sequence});
      const acknowledged = Math.max(0, Number(message.ackInput) || 0);
      const sentAt = inputSentAt.get(acknowledged);
      if (sentAt != null) {
        const sample = Math.max(0, performance.now() - sentAt);
        controlLatencyMs = controlLatencyMs == null ? sample : controlLatencyMs * 0.68 + sample * 0.32;
      }
      for (const sequenceNumber of [...inputSentAt.keys()]) {
        if (sequenceNumber <= acknowledged) inputSentAt.delete(sequenceNumber);
      }
      for (const gameEvent of message.events || []) handleGameEvent(gameEvent);
      if ($("game").hidden) openGame("Ты вошёл в свободную бухту. Мир работает на сервере Cloudflare.");
      else render();
      return;
    }

    if (message.type === "network-closed") {
      const waiting = message.waitingFor === "captain" ? "создателя мира" : "второго игрока";
      announce(`Игрок отключился. Сервер продолжает мир и ждёт ${waiting}.`, true);
    }
  });

  connection.addEventListener("error", () => {
    if (socket !== connection) return;
    if (!reconnecting && !lobbyReady && $("game").hidden) {
      announce("Cloudflare Worker не открыл свободный мир. Обнови страницу и попробуй ещё раз.", true);
      resetButtons();
    }
  });
  connection.addEventListener("close", () => {
    clearTimeout(connectionDeadline);
    connectionDeadline = 0;
    if (socket !== connection) return;
    socket = null;
    stopHeartbeat();
    stopLatencyProbe();
    if (!leavingGame && world && !$("game").hidden) {
      reconnectToRoom(reconnectRole || (isHost ? "captain" : "crew"), reconnectRoom || roomId);
    } else if ($("game").hidden) {
      resetButtons();
    }
  });
}

function leaveGame() {
  leavingGame = true;
  resetReconnectState();
  releaseAllMovement();
  stopHeartbeat();
  stopLatencyProbe();
  speech.cancel();
  audio.stopAll();
  socket?.close(1000, "leave");
  location.href = "/free-roam.html";
}

function sendInput(force = false) {
  const serialized = JSON.stringify(localInput);
  if (!force && serialized === lastInputSent) return;
  lastInputSent = serialized;
  const sequence = ++inputSequence;
  inputSentAt.set(sequence, performance.now());
  while (inputSentAt.size > 48) inputSentAt.delete(inputSentAt.keys().next().value);
  send({type: "free-input", sequence, input: localInput});
}

function opposite(name) {
  return {up: "down", down: "up", left: "right", right: "left"}[name] || null;
}

function setControl(name, active) {
  if (!(name in localInput)) return;
  let changed = localInput[name] !== Boolean(active);
  if (active && movementNames.includes(name)) {
    const other = opposite(name);
    if (other && localInput[other]) {
      localInput[other] = false;
      changed = true;
    }
  }
  if (!changed) return false;
  localInput[name] = Boolean(active);
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
  localInput.shopPrevious = false;
  localInput.shopNext = false;
  localInput.shopBuy = false;
  localInput.shopClose = false;
  localInput.boardPrevious = false;
  localInput.boardNext = false;
  localInput.boardAccept = false;
  localInput.boardClose = false;
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
  $("pumpButton").setAttribute("aria-pressed", String(localInput.pump));
  $("pumpButton").textContent = `Насос: ${localInput.pump ? "включён" : "выключен"}`;
  $("repairButton").setAttribute("aria-pressed", String(localInput.repair));
  $("repairButton").textContent = `Пластина: ${localInput.repair ? "ставится" : "готова"}`;
  const guideActive = Boolean(world?.freeScenario?.guideEnabled?.[playerIndex]);
  $("guideButton").setAttribute("aria-pressed", String(guideActive));
  $("guideButton").textContent = `Курс к сонару: ${guideActive ? "включён" : "выключен"}`;
}

function handleGameEvent(event) {
  audio.handleFreeEvent(event, playerIndex);
  if (!event?.targets?.includes(playerIndex)) return;
  if (["shop-open", "contract-board-open"].includes(event.type)) {
    if (targetMenu.isOpen()) targetMenu.close(false);
    releaseAllMovement();
  }
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

function frame(now) {
  if ($("game").hidden) return;
  const dt = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000));
  previousFrame = now;
  if (world) {
    predictLocalWorld(world, playerIndex, localInput, dt);
    if (now - lastRenderAt >= 32) {
      lastRenderAt = now;
      render();
    }
  }
  requestAnimationFrame(frame);
}

function render() {
  if (!world) return;
  const me = world.players[playerIndex];
  const other = world.players[1 - playerIndex];
  const myBoat = ["boat", "roof"].includes(me.mode) ? world.boats[me.activeBoat] : null;
  const labels = {boat: "в лодке", foot: "на берегу", swim: "в воде", roof: "на крыше", dead: "погиб"};
  const activities = world.freeActivities || {};
  const combat = me.combat || {};
  const merchantOpen = shopIsOpen();
  const boardOpen = boardIsOpen();
  const menuOpen = merchantOpen || boardOpen;
  const shopItem = selectedShopItem();
  const boardEntry = selectedBoardEntry();
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
  $("modeValue").textContent = combat.knockedDown ? "сбит с ног" : labels[me.mode] || me.mode;
  $("speedValue").textContent = combat.knockedDown ? "оглушён" : myBoat ? Math.abs(myBoat.speed).toFixed(1) : me.mode === "swim" ? "плывёт" : me.running ? "бежит" : "идёт";
  $("hullValue").textContent = myBoat ? `${Math.round(myBoat.hull)}%` : "—";
  $("waterValue").textContent = myBoat ? `${Math.round(myBoat.water)}%` : "—";
  $("towValue").textContent = !world.tow ? "нет" : world.tow.towerBoat === me.activeBoat ? "тащишь" : world.tow.towedBoat === me.activeBoat ? "тебя тащат" : "рядом";
  $("otherValue").textContent = activities.presence?.[1 - playerIndex] ? `${Math.round(distance(me, other))} м` : "ждём";
  $("healthValue").textContent = combat.alive === false
    ? `возрождение ${Math.ceil(combat.respawnRemaining || 0)} с`
    : combat.knockedDown
      ? `${Math.round(combat.health ?? 100)}%, оглушён`
      : `${Math.round(combat.health ?? 100)}%`;
  $("weaponValue").textContent = combat.equipped === "automatic" ? `автомат, ${combat.ammo || 0}` : weaponLabels[combat.equipped] || "кулаки";
  $("targetValue").textContent = lockedCombatTarget?.label || "не выбрана";
  $("cargoValue").textContent = combat.carriedCrate ? "в руках" : myBoat?.cargo?.length ? `${myBoat.cargo.length}, вес ${Math.round(myBoat.cargoWeight || 0)}` : "нет";
  $("scoreValue").textContent = `${activities.credits || 0}; металл ${world.freeContracts?.scrap || 0}`;
  $("scenarioValue").textContent = world.freeContracts?.activeContract
    ? `${world.freeContracts.activeContract.category}: ${world.freeContracts.activeContract.phase}`
    : {
      salvage: "доставка",
      arm: "поиск автомата",
      warning: "предупреждение",
      pursuit: "погоня",
      victory: "доска заказов",
    }[world.freeScenario?.phase] || "доставка";
  $("marauderValue").textContent = activePursuerCount
    ? `${activePursuerCount} катера; стрелков ${activeGunners.length}; цель ${Math.round(sonarPursuer?.hull ?? marauder.hull ?? 0)}%; пуль ${(pursuerSquad.projectiles || []).length + (world.freeHostileGunners?.projectiles || []).length}`
    : world.freeScenario?.phase === "victory"
      ? "все уничтожены"
      : "ещё не появились";
  const snapshotAge = lastStateAt ? Math.max(0, performance.now() - lastStateAt) : null;
  $("networkValue").textContent = [
    networkRttMs == null ? null : `сеть ${Math.round(networkRttMs)} мс`,
    inputReceiptMs == null ? null : `приём ${Math.round(inputReceiptMs)} мс`,
    controlLatencyMs == null ? null : `управление ${Math.round(controlLatencyMs)} мс`,
    snapshotAge == null ? null : `снимок ${Math.round(snapshotAge)} мс`,
  ].filter(Boolean).join(", ") || "измеряется";
  $("actionButton").textContent = merchantOpen
    ? `Купить: ${shopItem.label}`
    : boardOpen
      ? `Подтвердить: ${boardEntry?.label || "заказ"}`
    : combat.knockedDown
      ? "Сбит с ног — жди"
      : combat.carriedCrate
        ? "Положить / передать / погрузить"
        : nearContractBoard()
          ? "Открыть доску заказов"
          : nearMerchant()
          ? "Открыть магазин"
          : me.mode === "boat"
            ? "Груз / выйти / буксир"
            : me.mode === "roof"
              ? "Груз / сесть за руль"
              : "Взять груз / сесть в лодку";
  $("jumpButton").textContent = me.mode === "boat" ? "Плавучий тормоз" : me.mode === "roof" ? "Спрыгнуть" : "Прыжок / крыша";
  $("attackButton").textContent = combat.equipped === "automatic" ? "Огонь" : combat.equipped === "knife" ? "Удар ножом" : "Удар";
  $("weaponButton").textContent = `Оружие: ${weaponLabels[combat.equipped] || "кулаки"}`;
  $("targetButton").setAttribute("aria-pressed", String(targetMenu.isOpen()));
  $("targetButton").textContent = targetMenu.isOpen() ? "Выбор цели открыт" : "Выбрать цель";
  $("upButton").textContent = merchantOpen ? "Предыдущий товар" : boardOpen ? "Предыдущий заказ" : "Вперёд";
  $("downButton").textContent = merchantOpen ? "Следующий товар" : boardOpen ? "Следующий заказ" : "Назад / тормоз";
  $("sonarButton").textContent = merchantOpen ? "Закрыть магазин" : boardOpen ? "Закрыть доску" : "Сонар: текущая цель";
  for (const id of ["leftButton", "rightButton", "jumpButton", "attackButton", "weaponButton", "targetButton", "guideButton", "pumpButton", "repairButton"]) {
    $(id).disabled = menuOpen;
  }
  syncControlButtons();
  audio.updateWorld(world, playerIndex);
  drawMap(world);
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
    if (boardIsOpen()) {
      if (name === "up") actionPulse("boardPrevious");
      else if (name === "down") actionPulse("boardNext");
      return;
    }
    if (shopIsOpen()) {
      if (name === "up") actionPulse("shopPrevious");
      else if (name === "down") actionPulse("shopNext");
      return;
    }
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
  if (targetMenu.isOpen() || shopIsOpen() || boardIsOpen()) return;
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
  if (boardIsOpen()) {
    if (metrics.pointers === 1 && metrics.movement > 24) {
      actionPulse(metrics.dy < 0 ? "boardPrevious" : "boardNext");
    } else if (metrics.pointers === 1) {
      actionPulse("boardAccept");
    } else {
      actionPulse("boardClose");
    }
    return;
  }
  if (shopIsOpen()) {
    if (metrics.pointers === 1 && metrics.movement > 24) {
      actionPulse(metrics.dy < 0 ? "shopPrevious" : "shopNext");
    } else if (metrics.pointers === 1) {
      actionPulse("shopBuy");
    } else {
      actionPulse("shopClose");
    }
    return;
  }
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
    if (boardIsOpen()) {
      if (!event.repeat && event.code === "ArrowUp") actionPulse("boardPrevious");
      else if (!event.repeat && event.code === "ArrowDown") actionPulse("boardNext");
      else if (!event.repeat && ["Enter", "KeyF"].includes(event.code)) actionPulse("boardAccept");
      else if (!event.repeat && ["Escape", "KeyQ"].includes(event.code)) actionPulse("boardClose");
      else if (!["ArrowLeft", "ArrowRight"].includes(event.code)) return;
      event.preventDefault();
      audio.init().catch(() => {});
      return;
    }
    if (shopIsOpen()) {
      if (!event.repeat && event.code === "ArrowUp") actionPulse("shopPrevious");
      else if (!event.repeat && event.code === "ArrowDown") actionPulse("shopNext");
      else if (!event.repeat && ["Enter", "KeyF"].includes(event.code)) actionPulse("shopBuy");
      else if (!event.repeat && ["Escape", "KeyQ"].includes(event.code)) actionPulse("shopClose");
      else if (!["ArrowLeft", "ArrowRight"].includes(event.code)) return;
      event.preventDefault();
      audio.init().catch(() => {});
      return;
    }
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
    if (shopIsOpen() || boardIsOpen()) {
      if (["KeyX", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
      }
      return;
    }
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
  getNavigationTargetId: () => localInput.navigationTargetId,
  setNavigationTargetId: value => { localInput.navigationTargetId = value; },
  releaseMovement: releaseAllMovement,
  sendInput: () => sendInput(true),
  announce,
  render,
});

document.addEventListener("pointerdown", () => speech.prime(), {capture: true});
document.addEventListener("keydown", () => speech.prime(), {capture: true});
window.addEventListener("online", () => {
  if (!reconnectInProgress || leavingGame || $("game").hidden || socket) return;
  stopReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    reconnectAttempt += 1;
    connect(reconnectRole, {reconnecting: true, targetRoom: reconnectRoom});
  }, 100);
});

$("hostButton").addEventListener("click", () => connect("captain"));
$("joinButton").addEventListener("click", () => connect("auto"));
$("refreshButton").addEventListener("click", refreshRooms);
$("leaveButton").addEventListener("click", leaveGame);
$("statusButton").addEventListener("click", () => {
  if (world) announce(playerStatus(world, playerIndex), true);
});
$("speechButton").addEventListener("click", () => setSpeechEnabled(!speech.enabled));
$("controlModeButton").addEventListener("click", () => setGestureMode(!gestureMode));
bindHold($("upButton"), "up");
bindHold($("downButton"), "down");
bindHold($("leftButton"), "left");
bindHold($("rightButton"), "right");
$("actionButton").addEventListener("click", () => actionPulse(boardIsOpen() ? "boardAccept" : shopIsOpen() ? "shopBuy" : "action"));
$("jumpButton").addEventListener("click", () => actionPulse("jump"));
bindHold($("attackButton"), "attack", 90);
$("attackButton").addEventListener("click", event => {
  if (event.detail === 0) actionPulse("attack");
});
$("weaponButton").addEventListener("click", () => actionPulse("weapon"));
$("targetButton").addEventListener("click", () => {
  if (shopIsOpen() || boardIsOpen()) return;
  if (targetMenu.isOpen()) targetMenu.close(true);
  else targetMenu.open();
});
$("sonarButton").addEventListener("click", () => actionPulse(boardIsOpen() ? "boardClose" : shopIsOpen() ? "shopClose" : "sonar"));
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
  step: seconds => { if (world) { predictLocalWorld(world, playerIndex, localInput, seconds); render(); } },
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
    stateSequence: lastStateSequence,
    receivedStateCount,
    stateAgeMs: lastStateAt ? performance.now() - lastStateAt : null,
    networkRttMs,
    inputReceiptMs,
    controlLatencyMs,
    reconnecting: reconnectInProgress,
    reconnectAttempt,
  }),
  disconnectForTest: () => socket?.close(4100, "browser-test"),
  roomId: () => roomId,
  preferredRoom: () => preferredRoomId,
  handleEvent: event => handleGameEvent(event),
  targeting: targetMenu.snapshot,
  contracts: () => ({
    boardOpen: boardIsOpen(),
    selection: world?.freeContracts?.boardSelection?.[playerIndex] ?? 0,
    active: world?.freeContracts?.activeContract || null,
    offerIds: world?.freeContracts?.offerIds || [],
    scrap: world?.freeContracts?.scrap || 0,
    encounterActive: Boolean(world?.freeContracts?.encounterActive),
  }),
  shop: () => ({
    open: shopIsOpen(),
    selection: world?.freeActivities?.shopSelection?.[playerIndex] ?? 0,
    credits: world?.freeActivities?.credits ?? 0,
    itemId: selectedShopItem()?.id || null,
  }),
};
