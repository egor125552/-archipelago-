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
} from "./free-roam-core-v6.js";
import {FreeRoamAudio} from "./free-roam-audio-v5.js";
import {directionFromDelta} from "./free-roam-gesture-model.js";
import {classifyActionGesture, gestureMetrics} from "./free-roam-action-gestures.js";

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
};
const activeTouches = new Map();
const holdTimers = new Map();
const audio = new FreeRoamAudio();
let touchGroup = null;
let gestureDirection = null;
let gestureMode = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
let singleTapTimer = 0;
let lastSingleTapAt = 0;
let roomRefreshTimer = 0;
let heartbeatTimer = 0;
let preferredRoomId = "";
let socket = null;
let world = null;
let playerIndex = 0;
let isHost = false;
let roomId = "";
let previousFrame = 0;
let lastSnapshotAt = 0;
let lastInputSent = "";
let messageVersion = 0;
let readerInputDetected = false;
let selectedVoice = null;

function distance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е");
}

function voiceScore(voice) {
  if (!normalize(voice?.lang).startsWith("ru")) return -10000;
  const name = normalize(`${voice.name} ${voice.voiceURI}`);
  let score = 10;
  if (/milena|милена/.test(name)) score += 1000;
  if (/enhanced|premium|improved|natural|neural|улучш/.test(name)) score += 500;
  if (/compact|компакт/.test(name)) score -= 200;
  return score;
}

function refreshVoice() {
  if (!("speechSynthesis" in window)) return null;
  selectedVoice = [...window.speechSynthesis.getVoices()].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  return selectedVoice;
}

function resumeGameAudio() {
  if (audio?.ctx?.state === "suspended") audio.ctx.resume().catch(() => {});
}

function speak(text) {
  if (!text || readerInputDetected || !("speechSynthesis" in window)) return;
  refreshVoice();
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  utterance.rate = SPEECH_RATE;
  utterance.pitch = 1;
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.onend = resumeGameAudio;
  utterance.onerror = resumeGameAudio;
  window.speechSynthesis.speak(utterance);
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
  if (spoken) speak(text);
}

function socketUrl(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/connect`);
  url.searchParams.set("role", role);
  url.searchParams.set("mode", "free");
  if (role === "auto" && preferredRoomId) url.searchParams.set("room", preferredRoomId);
  return url.toString();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
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

function connect(role) {
  audio.init().catch(() => {});
  const requestedRole = role;
  isHost = requestedRole === "captain";
  playerIndex = isHost ? 0 : 1;
  $("hostButton").disabled = true;
  $("joinButton").disabled = true;
  announce(requestedRole === "captain" ? "Создаю свободный мир…" : "Ищу свободный мир…");

  socket = new WebSocket(socketUrl(role));
  socket.addEventListener("open", startHeartbeat);
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (_) { return; }

    if (message.type === "lobby-ready") {
      roomId = message.room || "";
      const actualRole = message.role || requestedRole;
      isHost = actualRole === "captain";
      playerIndex = isHost ? 0 : 1;
      $("roomLabel").textContent = `Свободный мир ${roomId}`;
      if (isHost) {
        world = createFreeWorld();
        setPlayerPresence(world, 0, true);
        setPlayerPresence(world, 1, Boolean(message.matched));
        const openedText = message.matched
          ? "Свободный мир найден. Ты принял управление миром; второй игрок уже рядом."
          : requestedRole === "auto"
            ? message.replacedStale
              ? "Ожидавший мир уже закрылся до подключения. Создан новый мир; ждём второго игрока."
              : "Свободных миров не было. Создан новый мир; ждём второго игрока."
            : "Мир создан. Можно ездить одному; ждём второго игрока.";
        openGame(openedText);
        sendSnapshot(true);
      } else if (!message.matched) {
        announce("Свободных миров не было. Создано место ожидания первого игрока.");
      } else {
        announce("Мир найден. Жду состояние бухты от первого игрока…");
        send({type: "free-hello"});
      }
      refreshRooms();
      return;
    }

    if (message.type === "peer-connected") {
      if (isHost) {
        if (world) setPlayerPresence(world, 1, true);
        announce("Второй игрок подключён к свободной бухте.", true);
        sendSnapshot(true);
      } else {
        announce("Первый игрок подключён. Загружаю бухту…", true);
        send({type: "free-hello"});
      }
      return;
    }

    if (message.type === "free-hello" && isHost) {
      sendSnapshot(true);
      return;
    }

    if (message.type === "free-input" && isHost && world) {
      setPlayerPresence(world, 1, true);
      setPlayerInput(world, 1, message.input || {});
      return;
    }

    if (message.type === "free-snapshot" && !isHost) {
      world = message.world;
      if ($("game").hidden) openGame("Ты вошёл в свободную бухту. У тебя отдельная лодка.");
      render();
      return;
    }

    if (message.type === "free-events") {
      for (const gameEvent of message.events || []) handleGameEvent(gameEvent);
      return;
    }

    if (message.type === "network-closed") {
      if (isHost && world) setPlayerPresence(world, 1, false);
      const waiting = message.waitingFor === "captain" ? "создателя мира" : "второго игрока";
      announce(`Игрок отключился. Комната сохранена и ждёт ${waiting}.`, true);
    }
  });

  socket.addEventListener("error", () => {
    announce("Cloudflare Worker не открыл свободный мир. Обнови страницу и попробуй ещё раз.", true);
    resetButtons();
  });
  socket.addEventListener("close", () => {
    stopHeartbeat();
    if ($("game").hidden) resetButtons();
  });
}

function leaveGame() {
  releaseAllMovement();
  stopHeartbeat();
  audio.stopAll();
  socket?.close(1000, "leave");
  location.href = "/free-roam.html";
}

function sendSnapshot(force = false) {
  if (!isHost || !world) return;
  const now = performance.now();
  if (!force && now - lastSnapshotAt < 90) return;
  lastSnapshotAt = now;
  send({type: "free-snapshot", world: snapshotWorld(world)});
}

function sendInput(force = false) {
  if (isHost) {
    if (world) setPlayerInput(world, playerIndex, localInput);
    return;
  }
  const serialized = JSON.stringify(localInput);
  if (!force && serialized === lastInputSent) return;
  lastInputSent = serialized;
  send({type: "free-input", input: localInput});
}

function opposite(name) {
  return {up: "down", down: "up", left: "right", right: "left"}[name] || null;
}

function setControl(name, active) {
  if (!(name in localInput)) return;
  if (active && movementNames.includes(name)) {
    const other = opposite(name);
    if (other) localInput[other] = false;
  }
  localInput[name] = Boolean(active);
  sendInput(true);
  syncControlButtons();
}

function toggleControl(name) {
  setControl(name, !localInput[name]);
}

function actionPulse(name, duration = 90) {
  setControl(name, true);
  clearTimeout(holdTimers.get(name));
  holdTimers.set(name, setTimeout(() => setControl(name, false), duration));
}

function releaseAllMovement() {
  for (const name of movementNames) localInput[name] = false;
  localInput.run = false;
  localInput.attack = false;
  activeTouches.clear();
  touchGroup = null;
  clearTimeout(singleTapTimer);
  singleTapTimer = 0;
  lastSingleTapAt = 0;
  gestureDirection = null;
  sendInput(true);
}

function syncControlButtons() {
  $("pumpButton").setAttribute("aria-pressed", String(localInput.pump));
  $("pumpButton").textContent = `Насос: ${localInput.pump ? "включён" : "выключен"}`;
  $("repairButton").setAttribute("aria-pressed", String(localInput.repair));
  $("repairButton").textContent = `Пластина: ${localInput.repair ? "ставится" : "готова"}`;
}

function handleGameEvent(event) {
  audio.handleFreeEvent(event, playerIndex);
  if (!event?.targets?.includes(playerIndex)) return;
  if (["hull-repair-complete", "repair-blocked"].includes(event.type)) setControl("repair", false);
  if (!event.text) return;
  const critical = [
    "sink", "ram", "tow-detach", "flood-emergency-start", "flood-emergency-warning",
    "flood-emergency-failed", "engine-stall", "engine-flooded", "fuel-empty-ready",
  ].includes(event.type);
  announce(event.text, critical);
}

function frame(now) {
  if ($("game").hidden) return;
  const dt = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000));
  previousFrame = now;
  if (isHost && world) {
    setPlayerInput(world, playerIndex, localInput);
    stepFreeWorld(world, dt);
    const events = drainEvents(world);
    for (const event of events) handleGameEvent(event);
    if (events.length) send({type: "free-events", events});
    sendSnapshot();
  }
  render();
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
  const marauder = activities.marauder || {};
  const weaponLabels = {fists: "кулаки", knife: "нож", automatic: "автомат"};
  $("modeValue").textContent = labels[me.mode] || me.mode;
  $("speedValue").textContent = myBoat ? Math.abs(myBoat.speed).toFixed(1) : me.mode === "swim" ? "плывёт" : me.running ? "бежит" : "идёт";
  $("hullValue").textContent = myBoat ? `${Math.round(myBoat.hull)}%` : "—";
  $("waterValue").textContent = myBoat ? `${Math.round(myBoat.water)}%` : "—";
  $("towValue").textContent = !world.tow ? "нет" : world.tow.towerBoat === me.activeBoat ? "тащишь" : world.tow.towedBoat === me.activeBoat ? "тебя тащат" : "рядом";
  $("otherValue").textContent = activities.presence?.[1 - playerIndex] ? `${Math.round(distance(me, other))} м` : "ждём";
  $("healthValue").textContent = combat.alive === false ? `возрождение ${Math.ceil(combat.respawnRemaining || 0)} с` : `${Math.round(combat.health ?? 100)}%`;
  $("weaponValue").textContent = combat.equipped === "automatic" ? `автомат, ${combat.ammo || 0}` : weaponLabels[combat.equipped] || "кулаки";
  $("cargoValue").textContent = combat.carriedCrate ? "в руках" : myBoat?.cargo?.length ? `${myBoat.cargo.length}, вес ${Math.round(myBoat.cargoWeight || 0)}` : "нет";
  $("scoreValue").textContent = String(activities.score?.[playerIndex] || 0);
  $("marauderValue").textContent = marauder.destroyed ? "уничтожен" : `${Math.round(marauder.hull ?? 100)}%`;
  $("actionButton").textContent = combat.carriedCrate ? "Положить / передать / погрузить" : me.mode === "boat" ? "Груз / выйти / буксир" : me.mode === "roof" ? "Груз / сесть за руль" : "Взять груз / сесть в лодку";
  $("jumpButton").textContent = me.mode === "boat" ? "Плавучий тормоз" : me.mode === "roof" ? "Спрыгнуть" : "Прыжок / крыша";
  $("attackButton").textContent = combat.equipped === "automatic" ? "Огонь" : combat.equipped === "knife" ? "Удар ножом" : "Удар";
  $("weaponButton").textContent = `Оружие: ${weaponLabels[combat.equipped] || "кулаки"}`;
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

function runOneFingerTap(metrics) {
  const now = performance.now();
  if (lastSingleTapAt && now - lastSingleTapAt <= 310) {
    clearTimeout(singleTapTimer);
    singleTapTimer = 0;
    lastSingleTapAt = 0;
    runGestureCommand(classifyActionGesture({...metrics, taps: 2}));
    return;
  }
  lastSingleTapAt = now;
  clearTimeout(singleTapTimer);
  singleTapTimer = setTimeout(() => {
    lastSingleTapAt = 0;
    singleTapTimer = 0;
    runGestureCommand(classifyActionGesture({...metrics, taps: 1}));
  }, 315);
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
  if (metrics.pointers === 1 && metrics.movement <= 24 && metrics.duration < 520) runOneFingerTap(metrics);
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

document.addEventListener("click", event => {
  if (event.detail === 0 && event.target.closest("button")) readerInputDetected = true;
}, true);
if ("speechSynthesis" in window) {
  refreshVoice();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshVoice);
}

$("hostButton").addEventListener("click", () => connect("captain"));
$("joinButton").addEventListener("click", () => connect("auto"));
$("refreshButton").addEventListener("click", refreshRooms);
$("leaveButton").addEventListener("click", leaveGame);
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
$("pumpButton").addEventListener("click", () => toggleControl("pump"));
$("repairButton").addEventListener("click", () => toggleControl("repair"));
bindGestures();
bindKeyboard();
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
  roomId: () => roomId,
  preferredRoom: () => preferredRoomId,
  handleEvent: event => handleGameEvent(event),
};
