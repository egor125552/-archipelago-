"use strict";

import {
  WORLD,
  createFreeWorld,
  drainEvents,
  playerStatus,
  setPlayerInput,
  snapshotWorld,
  stepFreeWorld,
} from "./free-roam-core-v4.js";
import {FreeRoamAudio} from "./free-roam-audio-v3.js";
import {directionFromDelta, isTwoFingerTap} from "./free-roam-gesture-model.js";

const $ = id => document.getElementById(id);
const SPEECH_RATE = 1.18;
const movementNames = ["up", "down", "left", "right"];
const localInput = {up: false, down: false, left: false, right: false, pump: false, repair: false, action: false, jump: false};
const activeTouches = new Map();
const holdTimers = new Map();
const audio = new FreeRoamAudio();
let touchGroup = null;
let gestureDirection = null;
let gestureReturnTimer = 0;
let roomRefreshTimer = 0;
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
  return `${protocol}//${location.host}/api/connect?role=${role}&mode=free`;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
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
  isHost = role === "captain";
  playerIndex = isHost ? 0 : 1;
  $("hostButton").disabled = true;
  $("joinButton").disabled = true;
  announce(isHost ? "Создаю свободный мир…" : "Ищу свободный мир…");

  socket = new WebSocket(socketUrl(role));
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (_) { return; }

    if (message.type === "lobby-ready") {
      roomId = message.room || "";
      $("roomLabel").textContent = `Свободный мир ${roomId}`;
      if (isHost) {
        world = createFreeWorld();
        openGame(message.matched ? "Второй игрок уже подключён." : "Мир создан. Можно ездить одному; ждём второго игрока.");
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
      announce("Второй игрок отключился. Твоя лодка и мир остаются доступны.", true);
    }
  });

  socket.addEventListener("error", () => {
    announce("Cloudflare Worker не открыл свободный мир. Обнови страницу и попробуй ещё раз.", true);
    resetButtons();
  });
  socket.addEventListener("close", () => {
    if ($("game").hidden) resetButtons();
  });
}

function leaveGame() {
  releaseAllMovement();
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
    if (world) setPlayerInput(world, 0, localInput);
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
    setPlayerInput(world, 0, localInput);
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
  const labels = {boat: "в лодке", foot: "на берегу", swim: "в воде", roof: "на крыше"};
  $("modeValue").textContent = labels[me.mode] || me.mode;
  $("speedValue").textContent = myBoat ? Math.abs(myBoat.speed).toFixed(1) : me.mode === "swim" ? "плывёт" : "пешком";
  $("hullValue").textContent = myBoat ? `${Math.round(myBoat.hull)}%` : "—";
  $("waterValue").textContent = myBoat ? `${Math.round(myBoat.water)}%` : "—";
  $("towValue").textContent = !world.tow ? "нет" : world.tow.towerBoat === me.activeBoat ? "тащишь" : world.tow.towedBoat === me.activeBoat ? "тебя тащат" : "рядом";
  $("otherValue").textContent = `${Math.round(distance(me, other))} м`;
  $("actionButton").textContent = me.mode === "boat" ? "Выйти / буксир / обслуживание" : me.mode === "roof" ? "Сесть за руль" : "Сесть в лодку";
  $("jumpButton").textContent = me.mode === "boat" ? "Плавучий тормоз" : me.mode === "roof" ? "Спрыгнуть" : "Прыжок / крыша";
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
  ctx.fillRect(0, 0, canvas.width, WORLD.shoreY * sy);
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
    if (player.mode === "boat") continue;
    ctx.fillStyle = player.id === playerIndex ? "#ffffff" : "#ffdc7e";
    ctx.beginPath();
    ctx.arc(player.x * sx, player.y * sy, player.mode === "roof" ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function showButtonsForAssistiveInput() {
  clearTimeout(gestureReturnTimer);
  document.body.classList.remove("gesture-active");
}

function hideButtonsAfterGesture() {
  document.body.classList.add("gesture-active");
  clearTimeout(gestureReturnTimer);
  gestureReturnTimer = setTimeout(() => document.body.classList.remove("gesture-active"), 3800);
}

function bindHold(button, name) {
  const down = event => {
    if (event.pointerType === "touch") showButtonsForAssistiveInput();
    event.preventDefault();
    audio.init().catch(() => {});
    setControl(name, true);
    button.setPointerCapture?.(event.pointerId);
  };
  const up = event => {
    event.preventDefault();
    setControl(name, false);
  };
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("lostpointercapture", up);
}

function applyGestureDirection(direction) {
  if (direction === gestureDirection) return;
  if (gestureDirection) setControl(gestureDirection, false);
  gestureDirection = direction;
  if (gestureDirection) {
    setControl(gestureDirection, true);
    hideButtonsAfterGesture();
  }
}

function releaseGestureDirection() {
  if (gestureDirection) setControl(gestureDirection, false);
  gestureDirection = null;
}

function beginTouch(event) {
  if (event.pointerType !== "touch" || event.target.closest("button")) return;
  event.preventDefault();
  audio.init().catch(() => {});
  const point = {x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY};
  activeTouches.set(event.pointerId, point);
  if (!touchGroup) touchGroup = {startedAt: performance.now(), points: new Map(), maxPointers: 0};
  touchGroup.points.set(event.pointerId, point);
  touchGroup.maxPointers = Math.max(touchGroup.maxPointers, activeTouches.size);
  if (touchGroup.maxPointers > 1) releaseGestureDirection();
  $("playSurface").setPointerCapture?.(event.pointerId);
}

function moveTouch(event) {
  const point = activeTouches.get(event.pointerId);
  if (!point) return;
  event.preventDefault();
  point.lastX = event.clientX;
  point.lastY = event.clientY;
  if (!touchGroup || touchGroup.maxPointers !== 1 || activeTouches.size !== 1) return;
  const direction = directionFromDelta(point.lastX - point.x, point.lastY - point.y, 26);
  if (direction) applyGestureDirection(direction);
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
  const duration = group ? performance.now() - group.startedAt : Infinity;
  const movements = group ? [...group.points.values()].map(item => Math.hypot(item.lastX - item.x, item.lastY - item.y)) : [];
  const pumpTap = !cancelled && group && isTwoFingerTap({maxPointers: group.maxPointers, duration, movements});
  releaseGestureDirection();
  if (pumpTap) {
    toggleControl("pump");
    announce(`Насос ${localInput.pump ? "включён" : "выключен"}.`);
    hideButtonsAfterGesture();
  } else if (document.body.classList.contains("gesture-active")) {
    hideButtonsAfterGesture();
  }
}

function bindGestures() {
  const surface = $("playSurface");
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
    if (movement) {
      event.preventDefault();
      setControl(movement, true);
    } else if (!event.repeat && event.code === "KeyF") {
      event.preventDefault();
      actionPulse("action");
    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      actionPulse("jump");
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
    $("roomsSummary").textContent = rooms.length ? `Свободных миров: ${rooms.length}.` : "Свободных миров нет. Кнопка входа создаст ожидание первого игрока.";
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
$("joinButton").addEventListener("click", () => connect("crew"));
$("refreshButton").addEventListener("click", refreshRooms);
$("leaveButton").addEventListener("click", leaveGame);
$("statusButton").addEventListener("click", () => {
  if (world) announce(playerStatus(world, playerIndex), true);
});
bindHold($("upButton"), "up");
bindHold($("downButton"), "down");
bindHold($("leftButton"), "left");
bindHold($("rightButton"), "right");
$("actionButton").addEventListener("click", () => actionPulse("action"));
$("jumpButton").addEventListener("click", () => actionPulse("jump"));
$("pumpButton").addEventListener("click", () => toggleControl("pump"));
$("repairButton").addEventListener("click", () => toggleControl("repair"));
bindGestures();
bindKeyboard();
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
};
