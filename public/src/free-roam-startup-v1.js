"use strict";

const SPEECH_PREFERENCE_KEY = "echo-free-roam-speech";
const SPEECH_DEFAULT_MIGRATION_KEY = "echo-free-roam-speech-default-v2";
const INTERFACE_SETTINGS_KEY = "echo-free-roam-interface-settings-v1";

try {
  if (localStorage.getItem(SPEECH_DEFAULT_MIGRATION_KEY) !== "done") {
    // An older VoiceOver workaround could mistake an accessibility-generated
    // keyboard-style click for a request to disable game speech. That stale
    // value survived after the workaround itself was removed. Reset only that
    // old disabled value once; later explicit choices remain persistent.
    if (localStorage.getItem(SPEECH_PREFERENCE_KEY) === "off") {
      localStorage.removeItem(SPEECH_PREFERENCE_KEY);
    }
    localStorage.setItem(SPEECH_DEFAULT_MIGRATION_KEY, "done");
  }
} catch (_) {
  // Private browsing or storage restrictions must not prevent the game start.
}

(() => {
  const SESSION_KEY = "echo-free-roam-active-session-v1";
  const NativeWebSocket = globalThis.WebSocket;
  let resumeSession = null;
  let resumePending = false;
  let leaveConfirmUntil = 0;

  function autoResumeEnabled() {
    try {
      const settings = JSON.parse(localStorage.getItem(INTERFACE_SETTINGS_KEY) || "null");
      return settings?.autoResume === true;
    } catch (_) {
      return false;
    }
  }

  function readSession() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return parsed?.room && ["captain", "crew"].includes(parsed.role) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveSession(room, role) {
    if (!room || !["captain", "crew"].includes(role)) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({room, role})); } catch (_) {}
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    resumeSession = null;
    resumePending = false;
  }

  function syncSessionFromGame() {
    const api = globalThis.__freeRoam;
    const game = document.getElementById("game");
    if (!api || !game || game.hidden) return false;
    const room = String(api.roomId?.() || "").trim();
    if (!room) return false;
    saveSession(room, api.isHost?.() ? "captain" : "crew");
    return true;
  }

  function guardedSocketUrl(input) {
    if (!resumePending || !resumeSession) return input;
    try {
      const url = new URL(String(input), location.href);
      if (url.pathname !== "/api/connect" || url.searchParams.get("mode") !== "free") return input;
      url.searchParams.set("room", resumeSession.room);
      url.searchParams.set("role", resumeSession.role);
      resumePending = false;
      return url.toString();
    } catch (_) {
      return input;
    }
  }

  function GuardedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(guardedSocketUrl(url))
      : new NativeWebSocket(guardedSocketUrl(url), protocols);
    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "lobby-ready") saveSession(message.room, message.role);
      } catch (_) {}
    });
    return socket;
  }

  if (typeof NativeWebSocket === "function") {
    GuardedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
    globalThis.WebSocket = GuardedWebSocket;
  }

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
      return;
    }
    clearSession();
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

  if (autoResumeEnabled()) {
    resumeSession = readSession();
    resumePending = Boolean(resumeSession);
  }

  function resumeWorld() {
    if (!resumeSession) return;
    const lobby = document.getElementById("lobby");
    const button = document.getElementById(resumeSession.role === "captain" ? "hostButton" : "joinButton");
    // The button exists as soon as HTML is parsed, but its click handler is
    // attached later by the deferred game module. Clicking before
    // window.__freeRoam exists silently does nothing and used to strand a
    // reloaded player in the lobby forever. Wait for the real bindings.
    if (!globalThis.__freeRoam || !button || button.disabled || lobby?.hidden) {
      setTimeout(resumeWorld, 80);
      return;
    }
    button.click();
  }

  if (resumeSession) setTimeout(resumeWorld, 0);

  // WebSocket messages are still the fastest way to save the room, but the
  // browser is allowed to reload or suspend a page at awkward moments. Keep a
  // second independent copy path and perform one final synchronous save on
  // pagehide so a hard refresh can always return to the same role and world
  // when automatic return is enabled in settings.
  setInterval(syncSessionFromGame, 500);
  window.addEventListener("pagehide", syncSessionFromGame);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) syncSessionFromGame();
  });

  globalThis.__freeRoamSessionGuard = {
    active: () => readSession(),
    autoResumeEnabled,
    clear: clearSession,
    save: saveSession,
    sync: syncSessionFromGame,
  };
})();
