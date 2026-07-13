"use strict";

import {normalizeRoomCode} from "./network.js";

const $ = id => document.getElementById(id);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

function prepareHost() {
  const code = sanitizeInput() || randomRoom();
  $("roomInput").value = code;
  setStatus(`Интернет-комната ${code} создаётся. Передай этот код второму игроку.`);
}

function prepareJoin(event) {
  const code = sanitizeInput();
  if (code.length >= 4) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setStatus("Введи код из 4–6 латинских букв или цифр. Русские похожие буквы преобразуются автоматически.");
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
configureLocalMode();
window.addEventListener("resize", configureLocalMode, {passive: true});
