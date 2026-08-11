"use strict";

(function installFreeRoamKeyboardEdgeGuard(global) {
  if (!global || global.__freeRoamKeyboardEdgeGuardV1) return;

  const downCodes = new Set();

  function codeOf(event) {
    return String(event?.code || "").trim();
  }

  function onKeyDown(event) {
    const code = codeOf(event);
    if (!code || event?.repeat) return;
    if (!downCodes.has(code)) {
      downCodes.add(code);
      return;
    }

    // Safari + VoiceOver can emit two non-repeat keydown events for one
    // physical press: first key="Unidentified", then the real character, while
    // both carry the same KeyboardEvent.code. A toggle action must receive one
    // edge, not two opposite transitions.
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  function onKeyUp(event) {
    const code = codeOf(event);
    if (code) downCodes.delete(code);
  }

  function reset() {
    downCodes.clear();
  }

  global.addEventListener?.("keydown", onKeyDown, true);
  global.addEventListener?.("keyup", onKeyUp, true);
  global.addEventListener?.("blur", reset, true);
  global.document?.addEventListener?.("visibilitychange", () => {
    if (global.document.hidden) reset();
  }, true);

  global.__freeRoamKeyboardEdgeGuardV1 = Object.freeze({
    isDown: code => downCodes.has(String(code || "")),
    reset,
  });
})(globalThis);
