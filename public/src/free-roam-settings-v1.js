"use strict";

(() => {
  const STORAGE_KEY = "echo-free-roam-interface-settings-v1";
  const DEFAULTS = Object.freeze({
    gameButtons: null,
    quickControl: false,
    quickSpeech: false,
  });
  const $ = id => document.getElementById(id);
  let returnFocus = null;

  function readPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return {
        gameButtons: typeof stored?.gameButtons === "boolean" ? stored.gameButtons : null,
        quickControl: stored?.quickControl === true,
        quickSpeech: stored?.quickSpeech === true,
      };
    } catch (_) {
      return {...DEFAULTS};
    }
  }

  let preferences = readPreferences();

  function savePreferences() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
  }

  function gameReady() {
    return Boolean(globalThis.__freeRoam);
  }

  function speechEnabled() {
    if (gameReady()) return globalThis.__freeRoam.speechDiagnostics?.().enabled !== false;
    try { return localStorage.getItem("echo-free-roam-speech") !== "off"; }
    catch (_) { return true; }
  }

  function gameButtonsEnabled() {
    if (typeof preferences.gameButtons === "boolean") return preferences.gameButtons;
    if (gameReady()) return !document.body.classList.contains("gesture-mode");
    return !(globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false);
  }

  function setPressed(button, pressed, text) {
    if (!button) return;
    button.setAttribute("aria-pressed", String(Boolean(pressed)));
    button.textContent = text;
  }

  function syncQuickButtons() {
    const controlModeButton = $("controlModeButton");
    const speechButton = $("speechButton");
    if (controlModeButton) controlModeButton.hidden = !preferences.quickControl;
    if (speechButton) speechButton.hidden = !preferences.quickSpeech;
  }

  function syncSettingsControls() {
    const buttonsOn = gameButtonsEnabled();
    const speechOn = speechEnabled();
    setPressed(
      $("settingsGameButtonsButton"),
      buttonsOn,
      `Кнопки управления: ${buttonsOn ? "включены" : "выключены"}`,
    );
    setPressed(
      $("settingsQuickControlButton"),
      preferences.quickControl,
      `Быстрая кнопка управления: ${preferences.quickControl ? "показана" : "скрыта"}`,
    );
    setPressed(
      $("settingsSpeechButton"),
      speechOn,
      `Игровая озвучка: ${speechOn ? "включена" : "выключена"}`,
    );
    setPressed(
      $("settingsQuickSpeechButton"),
      preferences.quickSpeech,
      `Быстрая кнопка озвучки: ${preferences.quickSpeech ? "показана" : "скрыта"}`,
    );
  }

  function applyGameButtonsPreference() {
    if (!gameReady() || typeof preferences.gameButtons !== "boolean") return;
    const currentlyEnabled = !document.body.classList.contains("gesture-mode");
    if (currentlyEnabled !== preferences.gameButtons) $("controlModeButton")?.click();
  }

  function applyPreferences() {
    syncQuickButtons();
    applyGameButtonsPreference();
    syncSettingsControls();
  }

  function waitForGameBindings() {
    if (!gameReady()) {
      setTimeout(waitForGameBindings, 80);
      return;
    }
    applyPreferences();
  }

  function releaseGameControls() {
    const api = globalThis.__freeRoam;
    if (!api?.setControl) return;
    for (const name of ["up", "down", "left", "right", "run", "attack", "action", "jump", "weapon", "sonar", "guide"]) {
      api.setControl(name, false);
    }
  }

  function openSettings(event) {
    const panel = $("settingsPanel");
    if (!panel) return;
    returnFocus = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
    releaseGameControls();
    $("lobby")?.setAttribute("inert", "");
    $("game")?.setAttribute("inert", "");
    panel.hidden = false;
    document.body.classList.add("settings-open");
    syncSettingsControls();
    requestAnimationFrame(() => $("settingsTitle")?.focus({preventScroll: true}));
  }

  function closeSettings() {
    const panel = $("settingsPanel");
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove("settings-open");
    $("lobby")?.removeAttribute("inert");
    $("game")?.removeAttribute("inert");
    const target = returnFocus;
    returnFocus = null;
    requestAnimationFrame(() => target?.focus?.({preventScroll: true}));
  }

  function toggleGameButtons() {
    preferences.gameButtons = !gameButtonsEnabled();
    savePreferences();
    applyGameButtonsPreference();
    syncSettingsControls();
  }

  function toggleQuickControl() {
    preferences.quickControl = !preferences.quickControl;
    savePreferences();
    syncQuickButtons();
    syncSettingsControls();
  }

  function toggleSpeech() {
    const desired = !speechEnabled();
    const button = $("speechButton");
    if (gameReady() && button) button.click();
    else {
      try { localStorage.setItem("echo-free-roam-speech", desired ? "on" : "off"); } catch (_) {}
    }
    setTimeout(syncSettingsControls, 0);
  }

  function toggleQuickSpeech() {
    preferences.quickSpeech = !preferences.quickSpeech;
    savePreferences();
    syncQuickButtons();
    syncSettingsControls();
  }

  $("lobbySettingsButton")?.addEventListener("click", openSettings);
  $("gameSettingsButton")?.addEventListener("click", openSettings);
  $("settingsCloseButton")?.addEventListener("click", closeSettings);
  $("settingsGameButtonsButton")?.addEventListener("click", toggleGameButtons);
  $("settingsQuickControlButton")?.addEventListener("click", toggleQuickControl);
  $("settingsSpeechButton")?.addEventListener("click", toggleSpeech);
  $("settingsQuickSpeechButton")?.addEventListener("click", toggleQuickSpeech);

  $("controlModeButton")?.addEventListener("click", () => {
    setTimeout(() => {
      preferences.gameButtons = !document.body.classList.contains("gesture-mode");
      savePreferences();
      syncSettingsControls();
    }, 0);
  });
  $("speechButton")?.addEventListener("click", () => setTimeout(syncSettingsControls, 0));

  window.addEventListener("keydown", event => {
    const panel = $("settingsPanel");
    if (!panel || panel.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettings();
      return;
    }
    if (event.key !== "Tab") event.stopImmediatePropagation();
  }, true);

  $("settingsPanel")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) closeSettings();
  });

  syncQuickButtons();
  syncSettingsControls();
  waitForGameBindings();

  globalThis.__freeRoamSettings = {
    open: openSettings,
    close: closeSettings,
    snapshot: () => ({...preferences, gameButtonsEnabled: gameButtonsEnabled(), speechEnabled: speechEnabled()}),
  };
})();
