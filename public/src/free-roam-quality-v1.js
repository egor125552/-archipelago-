"use strict";

import {
  LIGHTWEIGHT_ACK_DELAY_MS,
  LIGHTWEIGHT_FRAME_INTERVAL_MS,
  isFreeStateAckPayload,
  resolveLightweightPreference,
} from "./free-roam-quality-model.js?v=1";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "echo-free-roam-lightweight";
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const nativeWebSocketSend = WebSocket.prototype.send;
const pendingAcks = new Map();
let lastGameFrameAt = -Infinity;

function readStoredPreference() {
  try { return localStorage.getItem(STORAGE_KEY) || ""; }
  catch (_) { return ""; }
}

let lightweightMode = resolveLightweightPreference({
  storedPreference: readStoredPreference(),
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  reducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
});

function sendPendingAck(socket) {
  const pending = pendingAcks.get(socket);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAcks.delete(socket);
  try { nativeWebSocketSend.call(socket, pending.payload); } catch (_) {}
}

function flushPendingAcks() {
  for (const socket of [...pendingAcks.keys()]) sendPendingAck(socket);
}

window.requestAnimationFrame = function requestAnimationFrame(callback) {
  if (!lightweightMode || callback?.name !== "frame") return nativeRequestAnimationFrame(callback);
  return nativeRequestAnimationFrame(timestamp => {
    const remaining = LIGHTWEIGHT_FRAME_INTERVAL_MS - (timestamp - lastGameFrameAt);
    if (remaining <= 0) {
      lastGameFrameAt = timestamp;
      callback(timestamp);
      return;
    }
    setTimeout(() => {
      const now = performance.now();
      lastGameFrameAt = now;
      callback(now);
    }, remaining);
  });
};

WebSocket.prototype.send = function send(data) {
  if (!lightweightMode || !isFreeStateAckPayload(data)) {
    return nativeWebSocketSend.call(this, data);
  }

  const previous = pendingAcks.get(this);
  if (previous) {
    previous.payload = data;
    return;
  }

  const pending = {payload: data, timer: 0};
  pending.timer = setTimeout(() => sendPendingAck(this), LIGHTWEIGHT_ACK_DELAY_MS);
  pendingAcks.set(this, pending);
};

function syncCanvas() {
  const canvas = $("map");
  if (!canvas) return;
  canvas.dataset.fullWidth ||= String(canvas.width || 840);
  canvas.dataset.fullHeight ||= String(canvas.height || 640);
  if (lightweightMode) {
    canvas.width = 1;
    canvas.height = 1;
  } else {
    canvas.width = Number(canvas.dataset.fullWidth) || 840;
    canvas.height = Number(canvas.dataset.fullHeight) || 640;
  }
}

function syncButton() {
  const button = $("performanceButton");
  if (!button) return;
  button.setAttribute("aria-pressed", String(lightweightMode));
  button.textContent = `Облегчённый режим: ${lightweightMode ? "включён" : "выключен"}`;
}

function syncGuideButton() {
  const button = $("guideButton");
  if (!button) return;
  button.setAttribute("aria-label", "Один раз повернуть лодку прямо к текущей цели сонара");
}

function announceMode() {
  const text = lightweightMode
    ? "Облегчённый режим включён. Карта отключена, а обновления выполняются реже."
    : "Облегчённый режим выключен. Карта и плавные обновления восстановлены.";
  const message = $("message");
  if (message) message.textContent = text;
  const live = $("live");
  if (live) {
    live.textContent = "";
    nativeRequestAnimationFrame(() => { live.textContent = text; });
  }
}

function setLightweightMode(enabled, {announce = true, persist = true} = {}) {
  lightweightMode = Boolean(enabled);
  document.body.classList.toggle("lightweight-mode", lightweightMode);
  if (!lightweightMode) {
    lastGameFrameAt = -Infinity;
    flushPendingAcks();
  }
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, lightweightMode ? "on" : "off"); } catch (_) {}
  }
  syncCanvas();
  syncButton();
  syncGuideButton();
  if (announce) announceMode();
  return lightweightMode;
}

$("performanceButton")?.addEventListener("click", () => {
  setLightweightMode(!lightweightMode);
});

setLightweightMode(lightweightMode, {announce: false, persist: false});

window.__freeRoamQuality = {
  get lightweight() { return lightweightMode; },
  setLightweightMode,
  pendingAckCount: () => pendingAcks.size,
};
