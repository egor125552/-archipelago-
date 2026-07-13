"use strict";

import {normalizeRoomCode} from "./network.js";

const $ = id => document.getElementById(id);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let activeRoomCode = "";

function randomRoom(length = 6) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => ALPHABET[value % ALPHABET.length]).join("");
}

function sanitizeInput() {
  const input = $("roomInput");
  if (!input) return "";
  const clean = normalizeRoomCode(input.value);
  if (input.value !== clean) input.value = clean;
  return clean;
}

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
  badge.innerHTML = '<strong id="roomBadgeText"></strong> <button id="copyRoomCode" class="small" type="button">Копировать код</button>';
  gameScreen.insertBefore(badge, mission);
  $("copyRoomCode")?.addEventListener("click", async () => {
    if (!activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(activeRoomCode);
      $("copyRoomCode").textContent = "Код скопирован";
    } catch (_) {
      $("copyRoomCode").textContent = `Код: ${activeRoomCode}`;
    }
  });
  return badge;
}

function showRoomBadge(code, roleText) {
  activeRoomCode = code;
  const badge = ensureRoomBadge();
  const text = $("roomBadgeText");
  if (text) text.textContent = `${roleText}. Комната: ${code}.`;
  if (badge) badge.hidden = false;
}

function prepareHost() {
  const code = sanitizeInput() || randomRoom();
  $("roomInput").value = code;
  showRoomBadge(code, "Ты капитан");
  setStatus(`Интернет-комната ${code} создаётся. Передай этот код второму игроку.`);
}

function prepareJoin(event) {
  const code = sanitizeInput();
  if (code.length < 4) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus("Введи код из 4–6 латинских букв или цифр. Русские похожие буквы преобразуются автоматически.");
    return;
  }
  showRoomBadge(code, "Ты системный оператор");
  setStatus(`Подключаемся к интернет-комнате ${code}…`);
}

function configureLocalMode() {
  const coarse = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
  const hostLocal = $("hostLocal");
  const joinLocal = $("joinLocal");
  const note = $("localRoomNote");
  if (!hostLocal || !joinLocal) return;

  if (coarse) {
    hostLocal.hidden = true;
    joinLocal.hidden = true;
    if (note) note.textContent = "На телефоне локальный режим отключён: Safari останавливает вкладку в фоне. Для двух устройств используй интернет-комнату.";
  } else {
    hostLocal.hidden = false;
    joinLocal.hidden = false;
    hostLocal.textContent = "Создать тест в двух окнах компьютера";
    joinLocal.textContent = "Войти в тест в этом браузере";
    if (note) note.textContent = "Локальный режим предназначен только для двух одновременно активных окон на компьютере. Для телефонов используй интернет-комнату.";
  }
}

const input = $("roomInput");
input?.addEventListener("input", sanitizeInput);
input?.addEventListener("blur", sanitizeInput);
$("hostPeer")?.addEventListener("click", prepareHost, true);
$("joinPeer")?.addEventListener("click", prepareJoin, true);
ensureRoomBadge();
configureLocalMode();
window.addEventListener("resize", configureLocalMode, {passive: true});
