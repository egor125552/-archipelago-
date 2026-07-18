"use strict";

import {
  WORLD,
  createFreeWorld,
  drainEvents,
  playerStatus,
  setPlayerInput,
  snapshotWorld,
  stepFreeWorld,
} from "./free-roam-core-v2.js";
import {FreeRoamAudio} from "./free-roam-audio.js";

const $ = id => document.getElementById(id);
const localInput = {up: false, down: false, left: false, right: false, pump: false, repair: false, action: false, jump: false};
let world = null;
let socket = null;
let playerIndex = 0;
let isHost = false;
let roomId = "";
let previousFrame = 0;
let lastSnapshotAt = 0;
let lastInputSent = "";
let gestureTimer = 0;
let roomRefreshTimer = 0;
let messageVersion = 0;
const activePointers = new Map();
const holdTimers = new Map();
const audio = new FreeRoamAudio();

function distance(a, b) { return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0)); }

function announce(text, assertive = false) {
  if (!text) return;
  $("message").textContent = text;
  const live = $("live");
  const version = ++messageVersion;
  live.setAttribute("aria-live", assertive ? "assertive" : "polite");
  live.textContent = "";
  requestAnimationFrame(() => {
    if (version === messageVersion) live.textContent = text;
  });
}

function socketUrl(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/connect?role=${role}&mode=free`;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
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
    try { message = JSON.parse(String(event.data)); } catch (_) { return; }

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

function leaveGame() {
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

function pulse(name, duration = 420) {
  setControl(name, true);
  clearTimeout(holdTimers.get(name));
  holdTimers.set(name, setTimeout(() => setControl(name, false), duration));
}

function setControl(name, active) {
  localInput[name] = Boolean(active);
  sendInput(true);
  syncControlButtons();
}

function toggleControl(name) {
  setControl(name, !localInput[name]);
}

function actionPulse(name) {
  setControl(name, true);
  setTimeout(() => setControl(name, false), 80);
}

function syncControlButtons() {
  $("pumpButton").setAttribute("aria-pressed", String(localInput.pump));
  $("pumpButton").textContent = `Насос: ${localInput.pump ? "включён" : "выключен"}`;
  $("repairButton").setAttribute("aria-pressed", String(localInput.repair));
  $("repairButton").textContent = `Пластина: ${localInput.repair ? "ставится" : "готова"}`;
}

function handleGameEvent(event) {
  audio.handleFreeEvent(event, playerIndex);
  if (event?.targets?.includes(playerIndex)) {
    if (event.type === "hull-repair-complete" || event.type === "repair-blocked") setControl("repair", false);
    if (event.text) announce(event.text, ["sink", "ram", "tow-detach", "flood-emergency-start", "flood-emergency-warning", "flood-emergency-failed"].includes(event.type));
  }
}

function frame(now) {
  if ($("game").hidden) return;
  const dt = Math.min(.1, Math.max(0, (now - previousFrame) / 1000));
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
  $("actionButton").textContent = me.mode === "boat" ? "Выйти / буксир" : me.mode === "roof" ? "Сесть за руль" : "Сесть в лодку";
  $("jumpButton").textContent = me.mode === "roof" ? "Спрыгнуть" : "Прыжок / крыша";
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
    ctx.strokeStyle = currentWorld.tow.tension > .7 ? "#ffb2a7" : "#e9dcaa";
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

  for (const p of currentWorld.players) {
    if (p.mode === "boat") continue;
    ctx.fillStyle = p.id === playerIndex ? "#ffffff" : "#ffdc7e";
    ctx.beginPath();
    ctx.arc(p.x * sx, p.y * sy, p.mode === "roof" ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
  }
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

function showButtonsForAssistiveInput() {
  clearTimeout(gestureTimer);
  document.body.classList.remove("gesture-active");
}

function hideButtonsAfterGesture() {
  document.body.classList.add("gesture-active");
  clearTimeout(gestureTimer);
  gestureTimer = setTimeout(() => document.body.classList.remove("gesture-active"), 3800);
}

function bindGestures() {
  const surface = $("playSurface");
  surface.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || event.target.closest("button")) return;
    audio.init().catch(() => {});
    activePointers.set(event.pointerId, {x: event.clientX, y: event.clientY, startedAt: performance.now(), lastX: event.clientX, lastY: event.clientY});
    surface.setPointerCapture?.(event.pointerId);
  });
  surface.addEventListener("pointermove", event => {
    const pointer = activePointers.get(event.pointerId);
    if (!pointer) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
  });
  const finish = event => {
    const pointer = activePointers.get(event.pointerId);
    if (!pointer) return;
    activePointers.delete(event.pointerId);
    const dx = pointer.lastX - pointer.x;
    const dy = pointer.lastY - pointer.y;
    const duration = performance.now() - pointer.startedAt;
    const movement = Math.hypot(dx, dy);

    if (activePointers.size === 1 && duration < 450 && movement < 22) {
      const remaining = [...activePointers.values()][0];
      const remainingMovement = Math.hypot(remaining.lastX - remaining.x, remaining.lastY - remaining.y);
      if (remainingMovement < 22) {
        toggleControl("pump");
        announce(`Насос ${localInput.pump ? "включён" : "выключен"}.`);
        activePointers.clear();
        hideButtonsAfterGesture();
        return;
      }
    }

    if (movement < 28) {
      if (document.body.classList.contains("gesture-active")) showButtonsForAssistiveInput();
      return;
    }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const direction = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    pulse(direction, direction === "up" || direction === "down" ? 650 : 480);
    hideButtonsAfterGesture();
  };
  surface.addEventListener("pointerup", finish);
  surface.addEventListener("pointercancel", event => activePointers.delete(event.pointerId));
}

function bindKeyboard() {
  const map = {ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right"};
  window.addEventListener("keydown", event => {
    if ($("game").hidden || event.altKey || event.ctrlKey || event.metaKey || event.target.matches("input, textarea, select")) return;
    if (map[event.key]) {
      event.preventDefault();
      setControl(map[event.key], true);
    } else if (!event.repeat && event.code === "KeyF") {
      event.preventDefault();
      actionPulse("action");
    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      actionPulse("jump");
    } else if (!event.repeat && event.code === "KeyC") {
      event.preventDefault();
      toggleControl("pump");
    } else if (!event.repeat && event.code === "KeyV") {
      event.preventDefault();
      toggleControl("repair");
    }
    audio.init().catch(() => {});
  }, true);
  window.addEventListener("keyup", event => {
    if (map[event.key]) {
      event.preventDefault();
      setControl(map[event.key], false);
    }
  }, true);
  window.addEventListener("blur", () => {
    for (const name of ["up", "down", "left", "right"]) setControl(name, false);
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
      const li = document.createElement("li");
      li.textContent = `Мир ${index + 1}: ждёт ${room.waitingFor === "captain" ? "создателя мира" : "второго игрока"}, ${room.ageSeconds} с.`;
      return li;
    }));
  } catch (error) {
    $("roomsSummary").textContent = `Сервер свободных миров не отвечает: ${error.message}.`;
    $("roomsList").replaceChildren();
  }
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
clearInterval(roomRefreshTimer);
roomRefreshTimer = setInterval(() => { if (!$("lobby").hidden) refreshRooms(); }, 5000);

window.__freeRoam = {
  getWorld: () => world,
  setWorld: value => { world = value; render(); },
  setPlayerIndex: value => { playerIndex = Number(value) || 0; render(); },
  input: localInput,
  step: seconds => { if (world) { stepFreeWorld(world, seconds); render(); } },
  status: () => world && playerStatus(world, playerIndex),
};
