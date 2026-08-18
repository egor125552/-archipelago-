"use strict";

export const KEYBOARD_REPEAT_STALE_MS = 1100;
export const KEYBOARD_INITIAL_STALE_MS = 2400;
const MOVEMENT_CODES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function createKeyboardReleaseWatchdog({
  release,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  repeatStaleMs = KEYBOARD_REPEAT_STALE_MS,
  initialStaleMs = KEYBOARD_INITIAL_STALE_MS,
  fallbackEnabled = true,
} = {}) {
  if (typeof release !== "function") throw new TypeError("keyboard release watchdog needs a release callback");
  const held = new Map();

  function clearStateTimer(state) {
    if (state?.timer) clearTimer(state.timer);
    if (state) state.timer = 0;
  }

  function timeoutFor(state) {
    if (state.sawRepeat) return Math.max(250, Number(repeatStaleMs) || KEYBOARD_REPEAT_STALE_MS);
    return fallbackEnabled ? Math.max(600, Number(initialStaleMs) || KEYBOARD_INITIAL_STALE_MS) : Infinity;
  }

  function arm(code, state) {
    clearStateTimer(state);
    const timeout = timeoutFor(state);
    if (!Number.isFinite(timeout)) return;
    const check = () => {
      state.timer = 0;
      if (held.get(code) !== state) return;
      const remaining = timeoutFor(state) - (now() - state.lastSeenAt);
      if (remaining > 0) {
        state.timer = setTimer(check, remaining);
        return;
      }
      held.delete(code);
      release(code, state.sawRepeat ? "repeat-stalled" : "keyup-missing");
    };
    state.timer = setTimer(check, timeout);
  }

  function keyDown(code, {repeat = false} = {}) {
    if (!MOVEMENT_CODES.has(code)) return false;
    const timestamp = now();
    let state = held.get(code);
    if (!state) {
      state = {lastSeenAt: timestamp, sawRepeat: false, timer: 0};
      held.set(code, state);
    }
    state.lastSeenAt = timestamp;
    if (repeat) state.sawRepeat = true;
    arm(code, state);
    return true;
  }

  function keyUp(code) {
    const state = held.get(code);
    if (!state) return false;
    clearStateTimer(state);
    held.delete(code);
    return true;
  }

  function reset() {
    for (const state of held.values()) clearStateTimer(state);
    held.clear();
  }

  return {
    keyDown,
    keyUp,
    reset,
    snapshot: () => [...held.entries()].map(([code, state]) => ({
      code,
      sawRepeat: state.sawRepeat,
      ageMs: Math.max(0, now() - state.lastSeenAt),
    })),
  };
}

function macSafariNeedsInitialFallback() {
  const ua = String(globalThis.navigator?.userAgent || "");
  const platform = String(globalThis.navigator?.platform || "");
  return /Mac/i.test(platform || ua)
    && /Safari/i.test(ua)
    && !/(Chrome|Chromium|CriOS|Edg|OPR)/i.test(ua);
}

function syntheticKeyName(code) {
  return ({ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight"})[code] || code;
}

export function installFreeRoamKeyboardReleaseWatchdog() {
  if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") return null;
  if (globalThis.__freeRoamKeyboardReleaseWatchdog) return globalThis.__freeRoamKeyboardReleaseWatchdog;

  const watchdog = createKeyboardReleaseWatchdog({
    fallbackEnabled: macSafariNeedsInitialFallback(),
    release(code, reason) {
      try {
        const event = new KeyboardEvent("keyup", {
          code,
          key: syntheticKeyName(code),
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "__echoSyntheticReleaseReason", {configurable: true, value: reason});
        window.dispatchEvent(event);
      } catch (_) {}
    },
  });

  const editable = target => target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));

  window.addEventListener("keydown", event => {
    if (!MOVEMENT_CODES.has(event.code) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (document.getElementById("game")?.hidden || editable(event.target)) return;
    watchdog.keyDown(event.code, {repeat: Boolean(event.repeat)});
  }, true);

  window.addEventListener("keyup", event => {
    if (MOVEMENT_CODES.has(event.code)) watchdog.keyUp(event.code);
  }, true);

  window.addEventListener("blur", () => watchdog.reset());
  window.addEventListener("pagehide", () => watchdog.reset());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) watchdog.reset();
  });

  globalThis.__freeRoamKeyboardReleaseWatchdog = watchdog;
  return watchdog;
}

installFreeRoamKeyboardReleaseWatchdog();
