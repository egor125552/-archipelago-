"use strict";

const KEY_BINDINGS = Object.freeze({
  ArrowLeft: Object.freeze({kind: "control", control: "left"}),
  ArrowRight: Object.freeze({kind: "control", control: "right"}),
  ArrowUp: Object.freeze({kind: "control", control: "forward"}),
  ArrowDown: Object.freeze({kind: "control", control: "reverse"}),
  s: Object.freeze({kind: "command", command: "sonar"}),
  " ": Object.freeze({kind: "command", command: "quick"}),
  p: Object.freeze({kind: "control", control: "pump"}),
  r: Object.freeze({kind: "control", control: "rescue"}),
});

export function getKeyboardBinding(key, modifiers = {}) {
  if (modifiers.isComposing || modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return null;
  const normalized = typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;
  return KEY_BINDINGS[normalized] || null;
}

export function isEditableKeyboardTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tagName = String(target.tagName || "").toLowerCase();
  return Boolean(target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select");
}

function installKeyboardControls() {
  const heldControls = new Set();
  const api = () => window.__echoArchipelago;
  const state = () => api()?.getState?.() || null;
  const gameIsActive = () => state()?.phase === "playing";

  function stopGameKey(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function releaseControl(control) {
    if (!heldControls.has(control)) return;
    heldControls.delete(control);
    api()?.control?.(control, false);
  }

  function releaseAllControls() {
    for (const control of [...heldControls]) releaseControl(control);
  }

  window.addEventListener("keydown", event => {
    if (!gameIsActive() || isEditableKeyboardTarget(event.target)) return;
    const binding = getKeyboardBinding(event.key, event);
    if (!binding) return;

    stopGameKey(event);

    if (binding.kind === "command") {
      if (!event.repeat) api()?.command?.(binding.command);
      return;
    }

    if (heldControls.has(binding.control)) return;
    if (api()?.control?.(binding.control, true)) heldControls.add(binding.control);
  }, true);

  window.addEventListener("keyup", event => {
    const binding = getKeyboardBinding(event.key);
    if (!binding) return;

    if (binding.kind === "control" && heldControls.has(binding.control)) {
      stopGameKey(event);
      releaseControl(binding.control);
      return;
    }

    if (gameIsActive() && !isEditableKeyboardTarget(event.target) && getKeyboardBinding(event.key, event)) {
      stopGameKey(event);
    }
  }, true);

  window.addEventListener("blur", releaseAllControls, {passive: true});
  window.addEventListener("pagehide", releaseAllControls, {passive: true});
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllControls();
  }, {passive: true});

  const ariaShortcuts = Object.freeze({
    leftButton: "ArrowLeft",
    rightButton: "ArrowRight",
    throttleButton: "ArrowUp",
    reverseButton: "ArrowDown",
    sonarButton: "S",
    quickAction: "Space",
    pumpButton: "P",
    rescueButton: "R",
  });

  for (const [id, shortcut] of Object.entries(ariaShortcuts)) {
    document.getElementById(id)?.setAttribute("aria-keyshortcuts", shortcut);
  }

  window.__echoKeyboardControls = {
    releaseAll: releaseAllControls,
    held: () => [...heldControls],
    getBinding: getKeyboardBinding,
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") installKeyboardControls();
