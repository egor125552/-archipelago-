"use strict";

(() => {
  const NativeWebSocket = globalThis.WebSocket;
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

  function GuardedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    const nativeAddEventListener = socket.addEventListener.bind(socket);
    const nativeSend = socket.send.bind(socket);
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

  document.addEventListener("touchmove", event => {
    const game = document.getElementById("game");
    if (game && !game.hidden && document.body.classList.contains("gesture-mode") && game.contains(event.target)) {
      event.preventDefault();
    }
  }, {capture: true, passive: false});

  globalThis.__freeRoamSessionGuard = {
    active: () => null,
    autoResumeEnabled: () => false,
    clear: () => {},
    localizeMessageData: data => data,
    save: () => false,
    sync: () => false,
    touchGameplay,
  };
})();

import("./free-roam-mega-bomb-client.js?v=10").catch(() => {});
