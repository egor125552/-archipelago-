"use strict";

const SPEECH_PREFERENCE_KEY = "echo-free-roam-speech";
const SPEECH_DEFAULT_MIGRATION_KEY = "echo-free-roam-speech-default-v2";

try {
  if (localStorage.getItem(SPEECH_DEFAULT_MIGRATION_KEY) !== "done") {
    if (localStorage.getItem(SPEECH_PREFERENCE_KEY) === "off") {
      localStorage.removeItem(SPEECH_PREFERENCE_KEY);
    }
    localStorage.setItem(SPEECH_DEFAULT_MIGRATION_KEY, "done");
  }
} catch (_) {}

(() => {
  const NativeWebSocket = globalThis.WebSocket;
  const MOBILE_SALVAGE_OBJECTIVE = "Задача: доставь два обычных ящика. Коснись двумя пальцами — сонар назовёт одну цель. Подойди к ящику ближе 12 метров и коснись экрана одним пальцем. После погрузки снова коснись двумя пальцами, доедь до причала и остановись — разгрузка автоматическая.";
  let leaveConfirmUntil = 0;
  let activeGameSocket = null;
  let activeNativeSend = null;
  let lastFreeInput = {};

  function touchGameplay() {
    return Number(navigator.maxTouchPoints || 0) > 0
      && Boolean(globalThis.matchMedia?.("(pointer: coarse)")?.matches);
  }

  function publishGameMessage(data) {
    try {
      const detail = JSON.parse(String(data));
      globalThis.dispatchEvent(new CustomEvent("free-roam-mega-bomb-message", {detail}));
    } catch (_) {}
  }

  function localizeMessageData(data) {
    if (!touchGameplay()) return data;
    try {
      const message = JSON.parse(String(data));
      if (message.type !== "free-state" || !Array.isArray(message.events)) return data;
      let changed = false;
      message.events = message.events.map(event => {
        const desktopObjective = event?.type === "scenario-objective"
          && typeof event.text === "string"
          && event.text.includes("Сонар Q")
          && event.text.includes("нажми F");
        if (!desktopObjective) return event;
        changed = true;
        return {...event, text: MOBILE_SALVAGE_OBJECTIVE};
      });
      return changed ? JSON.stringify(message) : data;
    } catch (_) {
      return data;
    }
  }

  function messageEventWithData(event, data) {
    if (data === event.data) return event;
    try {
      return new MessageEvent("message", {
        data,
        origin: event.origin,
        lastEventId: event.lastEventId,
        source: event.source,
        ports: event.ports,
      });
    } catch (_) {
      return {data, origin: event.origin, lastEventId: event.lastEventId};
    }
  }

  function GuardedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    const nativeAddEventListener = socket.addEventListener.bind(socket);
    const nativeRemoveEventListener = socket.removeEventListener.bind(socket);
    const nativeSend = socket.send.bind(socket);
    const wrappedMessageListeners = new WeakMap();
    const gameSocket = String(url || "").includes("/api/connect");

    if (gameSocket) {
      activeGameSocket = socket;
      activeNativeSend = nativeSend;
      lastFreeInput = {};
      nativeAddEventListener("message", event => publishGameMessage(event.data));
      nativeAddEventListener("close", () => {
        if (activeGameSocket === socket) {
          activeGameSocket = null;
          activeNativeSend = null;
          lastFreeInput = {};
        }
      });
    }

    socket.send = function sendGuarded(data) {
      if (gameSocket) {
        try {
          const message = JSON.parse(String(data));
          if (message?.type === "free-input" && message.input && typeof message.input === "object") {
            lastFreeInput = {...message.input, megaBomb: false};
          }
        } catch (_) {}
      }
      return nativeSend(data);
    };

    socket.addEventListener = function addGuardedListener(type, listener, options) {
      if (type !== "message" || !listener) return nativeAddEventListener(type, listener, options);
      const wrapped = event => {
        const data = localizeMessageData(event.data);
        const transformed = messageEventWithData(event, data);
        if (typeof listener === "function") listener.call(socket, transformed);
        else listener.handleEvent?.call(listener, transformed);
      };
      wrappedMessageListeners.set(listener, wrapped);
      return nativeAddEventListener(type, wrapped, options);
    };

    socket.removeEventListener = function removeGuardedListener(type, listener, options) {
      const wrapped = type === "message" ? wrappedMessageListeners.get(listener) : null;
      return nativeRemoveEventListener(type, wrapped || listener, options);
    };
    return socket;
  }

  if (typeof NativeWebSocket === "function") {
    GuardedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
    globalThis.WebSocket = GuardedWebSocket;
  }

  globalThis.__freeRoamMegaBombBridge = {
    fire() {
      if (typeof NativeWebSocket !== "function") return false;
      if (!activeGameSocket || !activeNativeSend || activeGameSocket.readyState !== NativeWebSocket.OPEN) return false;
      const baseInput = {...lastFreeInput, megaBomb: false};
      try {
        activeNativeSend(JSON.stringify({type: "free-input", sequence: 0, input: {...baseInput, megaBomb: true}}));
        activeNativeSend(JSON.stringify({type: "free-input", sequence: 0, input: baseInput}));
        return true;
      } catch (_) {
        return false;
      }
    },
  };

  function reportLeaveConfirmation() {
    const text = "Выход не выполнен. Чтобы действительно выйти из мира, нажми кнопку «Выйти» ещё раз.";
    const message = document.getElementById("message");
    const live = document.getElementById("live");
    if (message) message.textContent = text;
    if (live) {
      live.setAttribute("aria-live", "assertive");
      live.textContent = "";
      requestAnimationFrame(() => { live.textContent = text; });
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ru-RU";
      utterance.rate = 1.18;
      speechSynthesis.speak(utterance);
    } catch (_) {}
  }

  document.addEventListener("click", event => {
    const leaveButton = event.target instanceof Element ? event.target.closest("#leaveButton") : null;
    if (!leaveButton) return;
    const gestureMode = document.body.classList.contains("gesture-mode");
    const directPointerClick = Number(event.detail) > 0;
    const now = performance.now();
    if (gestureMode && directPointerClick && now > leaveConfirmUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      leaveConfirmUntil = now + 2800;
      reportLeaveConfirmation();
    }
  }, true);

  document.addEventListener("touchmove", event => {
    const game = document.getElementById("game");
    if (game && !game.hidden && document.body.classList.contains("gesture-mode") && game.contains(event.target)) {
      event.preventDefault();
    }
  }, {capture: true, passive: false});

  function removeReleaseDebugButton() {
    if (new URLSearchParams(location.search).get("gestureDebug") === "1") return;
    document.getElementById("gestureReportButton")?.remove();
  }

  new MutationObserver(removeReleaseDebugButton).observe(document.documentElement, {childList: true, subtree: true});
  removeReleaseDebugButton();

  globalThis.__freeRoamSessionGuard = {
    active: () => null,
    autoResumeEnabled: () => false,
    clear: () => {},
    localizeMessageData,
    save: () => false,
    sync: () => false,
    touchGameplay,
  };
})();

import("./free-roam-mega-bomb-client.js?v=4").catch(() => {});
