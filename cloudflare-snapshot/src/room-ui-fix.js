"use strict";

const $ = id => document.getElementById(id);
let activeRoom = "";
let refreshTimer = 0;

function setStatus(text) {
  const status = $("networkStatus");
  if (status) status.textContent = text;
}

function ensureRoomBadge() {
  let badge = $("roomBadge");
  if (badge) return badge;
  const gameScreen = $("gameScreen");
  const mission = $("missionMessage");
  if (!gameScreen || !mission) return null;
  badge = document.createElement("section");
  badge.id = "roomBadge";
  badge.className = "panel compact";
  badge.hidden = true;
  badge.innerHTML = '<strong id="roomBadgeText"></strong>';
  gameScreen.insertBefore(badge, mission);
  return badge;
}

function showRoomBadge(room, role, matched) {
  activeRoom = room || activeRoom;
  const badge = ensureRoomBadge();
  const text = $("roomBadgeText");
  const roleText = role === "captain" ? "Ты капитан" : "Ты системный оператор";
  if (text) text.textContent = `${roleText}. Интернет-комната ${activeRoom}. ${matched ? "Напарник подключён." : "Ждём напарника."}`;
  if (badge) badge.hidden = false;
}

function ensureLobbyPanel() {
  let panel = $("internetLobby");
  if (panel) return panel;
  const coop = document.querySelector(".coop-panel");
  const status = $("networkStatus");
  if (!coop || !status) return null;

  panel = document.createElement("section");
  panel.id = "internetLobby";
  panel.className = "internet-lobby";
  panel.setAttribute("aria-labelledby", "internetLobbyTitle");
  panel.innerHTML = `
    <h3 id="internetLobbyTitle">Свободные интернет-комнаты</h3>
    <p id="onlineRoomSummary" class="hint" role="status" aria-live="polite">Проверяю сервер комнат…</p>
    <ul id="onlineRoomList"></ul>
    <button id="refreshRooms" type="button" class="small">Обновить список комнат</button>
  `;
  coop.insertBefore(panel, status);
  $("refreshRooms")?.addEventListener("click", refreshRooms);
  return panel;
}

function roomDescription(room, index) {
  const waiting = room.waitingFor === "captain" ? "ждёт капитана" : "ждёт системного оператора";
  const age = room.ageSeconds < 10 ? "создана только что" : `ждёт ${room.ageSeconds} секунд`;
  return `Комната ${index + 1}: ${waiting}, ${age}.`;
}

async function refreshRooms() {
  ensureLobbyPanel();
  const summary = $("onlineRoomSummary");
  const list = $("onlineRoomList");
  try {
    const response = await fetch("/api/rooms?mode=ops", {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    if (list) {
      list.replaceChildren(...rooms.map((room, index) => {
        const item = document.createElement("li");
        item.textContent = roomDescription(room, index);
        return item;
      }));
    }
    if (summary) summary.textContent = rooms.length
      ? `Свободных комнат: ${rooms.length}. Кнопка входа выберет первую подходящую.`
      : "Свободных комнат нет. Кнопка входа создаст новую и будет ждать капитана.";
  } catch (error) {
    if (list) list.replaceChildren();
    if (summary) summary.textContent = `Сервер комнат пока не отвечает: ${error.message}.`;
  }
}

function configureInterface() {
  const input = $("roomInput");
  const label = input?.labels?.[0];
  if (input) {
    input.value = "AUTO";
    input.hidden = true;
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
  }
  if (label) label.hidden = true;

  const host = $("hostPeer");
  const join = $("joinPeer");
  if (host) host.textContent = "Создать интернет-комнату — я капитан";
  if (join) join.textContent = "Войти в ближайшую интернет-комнату";

  const coarse = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
  const hostLocal = $("hostLocal");
  const joinLocal = $("joinLocal");
  const note = $("localRoomNote");
  if (coarse) {
    if (hostLocal) hostLocal.hidden = true;
    if (joinLocal) joinLocal.hidden = true;
    if (note) note.textContent = "На телефоне показаны только настоящие интернет-комнаты.";
  } else {
    if (hostLocal) hostLocal.hidden = false;
    if (joinLocal) joinLocal.hidden = false;
    if (note) note.textContent = "Локальный тест открывается в двух вкладках одного компьютера; интернет-режим работает между разными устройствами.";
  }
}

function prepareInternet(role) {
  const input = $("roomInput");
  if (input) input.value = role === "captain" ? "HOST" : "AUTO";
  setStatus(role === "captain"
    ? "Создаю интернет-комнату. Код вводить не нужно…"
    : "Ищу свободную интернет-комнату. Если её нет, создам ожидание капитана…");
}

$("hostPeer")?.addEventListener("click", () => prepareInternet("captain"), true);
$("joinPeer")?.addEventListener("click", () => prepareInternet("crew"), true);
$("hostLocal")?.addEventListener("click", () => { if ($("roomInput")) $("roomInput").value = "LOCAL"; }, true);
$("joinLocal")?.addEventListener("click", () => { if ($("roomInput")) $("roomInput").value = "LOCAL"; }, true);

window.addEventListener("echo-room-ready", event => {
  const detail = event.detail || {};
  showRoomBadge(detail.room, detail.role, detail.matched);
  setStatus(detail.matched
    ? `Интернет-комната ${detail.room}: оба игрока подключены.`
    : `Интернет-комната ${detail.room}: ждём ${detail.waitingFor === "captain" ? "капитана" : "системного оператора"}.`);
  refreshRooms();
});

window.addEventListener("echo-room-peer-connected", event => {
  const detail = event.detail || {};
  showRoomBadge(detail.room || activeRoom, detail.role, true);
  setStatus(`Интернет-комната ${detail.room || activeRoom}: соединение между устройствами подтверждено.`);
  refreshRooms();
});

ensureRoomBadge();
ensureLobbyPanel();
configureInterface();
refreshRooms();
clearInterval(refreshTimer);
refreshTimer = setInterval(() => {
  if (!$("startScreen")?.hidden) refreshRooms();
}, 5000);
window.addEventListener("resize", configureInterface, {passive: true});
