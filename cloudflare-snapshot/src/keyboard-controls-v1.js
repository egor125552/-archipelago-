"use strict";

const KEY_BINDINGS = Object.freeze({
  ArrowLeft: Object.freeze({kind: "control", control: "left"}),
  ArrowRight: Object.freeze({kind: "control", control: "right"}),
  ArrowUp: Object.freeze({kind: "control", control: "forward"}),
  ArrowDown: Object.freeze({kind: "control", control: "reverse"}),
  KeyS: Object.freeze({kind: "command", command: "sonar"}),
  KeyC: Object.freeze({kind: "toggle-control", control: "pump"}),
  KeyV: Object.freeze({kind: "toggle-control", control: "hullRepair"}),
  KeyR: Object.freeze({kind: "toggle-control", control: "rescue"}),
  Space: Object.freeze({kind: "command", command: "anchor"}),
  Enter: Object.freeze({kind: "command", command: "quick"}),
});

const KEY_FALLBACKS = Object.freeze({
  s: KEY_BINDINGS.KeyS,
  c: KEY_BINDINGS.KeyC,
  v: KEY_BINDINGS.KeyV,
  r: KEY_BINDINGS.KeyR,
  " ": KEY_BINDINGS.Space,
  Enter: KEY_BINDINGS.Enter,
  ArrowLeft: KEY_BINDINGS.ArrowLeft,
  ArrowRight: KEY_BINDINGS.ArrowRight,
  ArrowUp: KEY_BINDINGS.ArrowUp,
  ArrowDown: KEY_BINDINGS.ArrowDown,
});

export function getKeyboardBinding(key, modifiers = {}, code = "") {
  if (modifiers.isComposing || modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return null;
  if (code && KEY_BINDINGS[code]) return KEY_BINDINGS[code];
  const normalized = typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;
  return KEY_FALLBACKS[normalized] || null;
}

export function isEditableKeyboardTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tagName = String(target.tagName || "").toLowerCase();
  return Boolean(target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select");
}

function installDesktopPresentation() {
  const shortcuts = Object.freeze({
    leftButton: ["←", "ArrowLeft"],
    rightButton: ["→", "ArrowRight"],
    throttleButton: ["↑", "ArrowUp"],
    reverseButton: ["↓", "ArrowDown"],
    sonarButton: ["S", "S"],
    pumpButton: ["C", "C"],
    repairHullButton: ["V", "V"],
    rescueButton: ["R", "R"],
    anchorButton: ["Пробел", "Space"],
    quickAction: ["Enter", "Enter"],
  });

  for (const [id, [label, ariaShortcut]] of Object.entries(shortcuts)) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.dataset.shortcutLabel = label;
    button.setAttribute("aria-keyshortcuts", ariaShortcut);
  }

  const deck = document.querySelector(".control-deck");
  if (deck && !document.getElementById("desktopControlsHelp")) {
    const panel = document.createElement("section");
    panel.id = "desktopControlsHelp";
    panel.className = "panel desktop-controls";
    panel.setAttribute("aria-labelledby", "desktopControlsTitle");
    panel.innerHTML = `
      <h2 id="desktopControlsTitle">Управление на компьютере</h2>
      <p>Стрелки: руль, газ и обычный тормоз. S — сонар. C — насос. V — пластина. R — трос. Пробел — плавучий тормоз. Enter — быстрое действие.</p>
      <p class="hint">Клавиши работают при выключенной быстрой навигации VoiceOver. Команды VoiceOver с Control и Option игра не перехватывает.</p>
    `;
    deck.parentNode.insertBefore(panel, deck);
  }

  if (!document.getElementById("desktopControlsStyle")) {
    const style = document.createElement("style");
    style.id = "desktopControlsStyle";
    style.textContent = `
      button[data-shortcut-label]::after {
        content: "  [" attr(data-shortcut-label) "]";
        font-size: .78em;
        font-weight: 900;
        opacity: .78;
        white-space: nowrap;
      }
      .desktop-controls { display: none; }
      .internet-lobby { margin: .8rem 0; padding: .8rem; border: 1px solid #315c6d; border-radius: .9rem; }
      .internet-lobby h3 { margin: 0 0 .4rem; }
      .internet-lobby ul { margin: .5rem 0; padding-left: 1.4rem; }
      @media (min-width: 44rem) {
        main { width: min(78rem, 100%); }
        .desktop-controls { display: block; }
        .control-deck {
          min-height: 0 !important;
          max-height: none !important;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          grid-template-areas:
            "sonar route quick quick"
            "left throttle right reverse";
          gap: .65rem;
        }
        .control { min-height: 4.4rem; }
        .systems { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .game-header-actions { grid-template-columns: repeat(2, minmax(9rem, 1fr)); min-width: 22rem; }
      }
    `;
    document.head.appendChild(style);
  }
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
    const binding = getKeyboardBinding(event.key, event, event.code);
    if (!binding) return;
    stopGameKey(event);

    if (binding.kind === "command") {
      if (!event.repeat) api()?.command?.(binding.command);
      return;
    }

    if (binding.kind === "toggle-control") {
      if (event.repeat) return;
      const active = Boolean(state()?.controls?.[binding.control]);
      api()?.control?.(binding.control, !active);
      return;
    }

    if (heldControls.has(binding.control)) return;
    if (api()?.control?.(binding.control, true)) heldControls.add(binding.control);
  }, true);

  window.addEventListener("keyup", event => {
    const binding = getKeyboardBinding(event.key, event, event.code);
    if (!binding) return;
    if (binding.kind === "control" && heldControls.has(binding.control)) releaseControl(binding.control);
    if (gameIsActive() && !isEditableKeyboardTarget(event.target)) stopGameKey(event);
  }, true);

  window.addEventListener("blur", releaseAllControls, {passive: true});
  window.addEventListener("pagehide", releaseAllControls, {passive: true});
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllControls();
  }, {passive: true});

  window.__echoKeyboardControls = {
    releaseAll: releaseAllControls,
    held: () => [...heldControls],
    getBinding: getKeyboardBinding,
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installDesktopPresentation();
  installKeyboardControls();
}
