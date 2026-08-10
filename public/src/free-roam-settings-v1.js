"use strict";

(() => {
  const STORAGE_KEY = "echo-free-roam-interface-settings-v1";
  const SPEECH_RATE_KEY = "echo-free-roam-speech-rate";
  const DEFAULTS = Object.freeze({
    gameButtons: null,
    quickControl: false,
    quickSpeech: false,
    autoResume: false,
    speechRate: 1.18,
  });
  const $ = id => document.getElementById(id);
  const clampRate = value => Math.max(0.6, Math.min(2, Number(value) || DEFAULTS.speechRate));
  let returnFocus = null;
  let previewTimer = 0;

  function readPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      const legacyRate = Number(localStorage.getItem(SPEECH_RATE_KEY));
      return {
        gameButtons: typeof stored?.gameButtons === "boolean" ? stored.gameButtons : null,
        quickControl: stored?.quickControl === true,
        quickSpeech: stored?.quickSpeech === true,
        autoResume: stored?.autoResume === true,
        speechRate: clampRate(Number.isFinite(Number(stored?.speechRate)) ? stored.speechRate : legacyRate),
      };
    } catch (_) {
      return {...DEFAULTS};
    }
  }

  let preferences = readPreferences();

  function savePreferences() {
    preferences.speechRate = clampRate(preferences.speechRate);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      localStorage.setItem(SPEECH_RATE_KEY, String(preferences.speechRate));
    } catch (_) {}
  }

  function currentSpeechRate() {
    return clampRate(preferences.speechRate);
  }

  function installSpeechRateHook() {
    const synth = globalThis.speechSynthesis;
    if (!synth || synth.__echoSpeechRateHookInstalled) return;
    const nativeSpeak = synth.speak?.bind?.(synth);
    if (!nativeSpeak) return;
    const wrappedSpeak = utterance => {
      try { utterance.rate = currentSpeechRate(); } catch (_) {}
      return nativeSpeak(utterance);
    };
    let installed = false;
    try {
      Object.defineProperty(synth, "speak", {configurable: true, value: wrappedSpeak});
      installed = synth.speak === wrappedSpeak;
    } catch (_) {}
    if (!installed) {
      try {
        const prototype = Object.getPrototypeOf(synth);
        Object.defineProperty(prototype, "speak", {
          configurable: true,
          value(utterance) {
            try { utterance.rate = currentSpeechRate(); } catch (_) {}
            return nativeSpeak(utterance);
          },
        });
        installed = true;
      } catch (_) {}
    }
    if (installed) {
      try { Object.defineProperty(synth, "__echoSpeechRateHookInstalled", {value: true}); } catch (_) {}
    }
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

  function speechRateLabel(rate = currentSpeechRate()) {
    if (rate <= 0.7) return "самая медленная";
    if (rate < 0.95) return "медленная";
    if (rate < 1.12) return "обычная";
    if (rate < 1.35) return "быстрая";
    if (rate < 1.7) return "очень быстрая";
    return "самая быстрая";
  }

  function setPressed(button, pressed, text) {
    if (!button) return;
    button.setAttribute("aria-pressed", String(Boolean(pressed)));
    button.textContent = text;
  }

  function ensureSpeechRateControl() {
    if ($("settingsSpeechRate")) return;
    const speechButton = $("settingsSpeechButton");
    const group = speechButton?.closest?.(".settings-group");
    if (!group) return;

    const wrapper = document.createElement("div");
    wrapper.className = "speech-rate-setting";

    const label = document.createElement("label");
    label.htmlFor = "settingsSpeechRate";
    label.textContent = "Скорость игровой речи";

    const slider = document.createElement("input");
    slider.id = "settingsSpeechRate";
    slider.type = "range";
    slider.min = "0.6";
    slider.max = "2";
    // 1.18 is the established default. A 0.02 step keeps that default on the
    // range's valid step grid, so keyboard/screen-reader arrows move it
    // predictably instead of snapping from a step-mismatched value.
    slider.step = "0.02";
    slider.value = String(currentSpeechRate());
    slider.setAttribute("aria-describedby", "settingsSpeechRateValue settingsSpeechRateHint");
    slider.style.width = "100%";

    const value = document.createElement("output");
    value.id = "settingsSpeechRateValue";
    value.htmlFor = "settingsSpeechRate";
    value.setAttribute("aria-live", "polite");

    const hint = document.createElement("p");
    hint.id = "settingsSpeechRateHint";
    hint.className = "settings-note";
    hint.textContent = "Стрелки меняют скорость постепенно. Слева — самая медленная, справа — самая быстрая. Изменение применяется к следующей фразе.";

    wrapper.append(label, slider, value, hint);
    const existingNote = group.querySelector(".settings-note");
    group.insertBefore(wrapper, existingNote || null);

    const applySlider = ({preview = false} = {}) => {
      preferences.speechRate = clampRate(slider.value);
      savePreferences();
      syncSpeechRateControl();
      if (!preview || !speechEnabled()) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        try {
          const Utterance = globalThis.SpeechSynthesisUtterance;
          if (!Utterance || !globalThis.speechSynthesis) return;
          const phrase = new Utterance("Проверка скорости речи.");
          phrase.lang = "ru-RU";
          globalThis.speechSynthesis.cancel();
          globalThis.speechSynthesis.speak(phrase);
        } catch (_) {}
      }, 180);
    };

    slider.addEventListener("input", () => applySlider());
    slider.addEventListener("change", () => applySlider({preview: true}));
  }

  function syncSpeechRateControl() {
    const slider = $("settingsSpeechRate");
    const value = $("settingsSpeechRateValue");
    const rate = currentSpeechRate();
    if (slider && Math.abs(Number(slider.value) - rate) > 0.001) slider.value = String(rate);
    if (slider) slider.setAttribute("aria-valuetext", `${rate.toFixed(2)}, ${speechRateLabel(rate)}`);
    if (value) value.textContent = `Текущая скорость: ${rate.toFixed(2)}, ${speechRateLabel(rate)}.`;
  }

  function syncQuickButtons() {
    const controlModeButton = $("controlModeButton");
    const speechButton = $("speechButton");
    if (controlModeButton) controlModeButton.hidden = !preferences.quickControl;
    if (speechButton) speechButton.hidden = !preferences.quickSpeech;
  }

  function syncSettingsControls() {
    ensureSpeechRateControl();
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
    setPressed(
      $("settingsAutoResumeButton"),
      preferences.autoResume,
      `После обновления: ${preferences.autoResume ? "вернуться в тот же мир" : "остаться в меню"}`,
    );
    syncSpeechRateControl();
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

  function toggleAutoResume() {
    preferences.autoResume = !preferences.autoResume;
    savePreferences();
    syncSettingsControls();
  }

  // The settings dialog has to consume game-control keys before the free-roam
  // capture listener sees them. Because that happens on window capture, native
  // range/button keyboard behavior cannot be allowed through normally: doing so
  // would also steer/jump/confirm in the running game. Reproduce the small set
  // of native control actions here, then consume the event. This keeps NVDA and
  // keyboard users in the dialog without sending input to the vessel.
  function handleSettingsControlKey(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;

    if (target instanceof HTMLInputElement && target.id === "settingsSpeechRate" && target.type === "range") {
      const key = event.key || event.code;
      const min = Number(target.min) || 0.6;
      const max = Number(target.max) || 2;
      const step = Number(target.step) || 0.02;
      const current = Number(target.value) || currentSpeechRate();
      let next = current;
      if (key === "ArrowRight" || key === "ArrowUp") next += step;
      else if (key === "ArrowLeft" || key === "ArrowDown") next -= step;
      else if (key === "PageUp") next += step * 5;
      else if (key === "PageDown") next -= step * 5;
      else if (key === "Home") next = min;
      else if (key === "End") next = max;
      else return false;

      event.preventDefault();
      next = Math.max(min, Math.min(max, next));
      target.value = String(Math.round(next * 100) / 100);
      target.dispatchEvent(new Event("input", {bubbles: true}));
      target.dispatchEvent(new Event("change", {bubbles: true}));
      return true;
    }

    if (target.matches("button") && !event.repeat && (event.key === "Enter" || event.key === " " || event.code === "Space")) {
      event.preventDefault();
      target.click();
      return true;
    }

    return false;
  }

  installSpeechRateHook();
  savePreferences();

  $("lobbySettingsButton")?.addEventListener("click", openSettings);
  $("gameSettingsButton")?.addEventListener("click", openSettings);
  $("settingsCloseButton")?.addEventListener("click", closeSettings);
  $("settingsGameButtonsButton")?.addEventListener("click", toggleGameButtons);
  $("settingsQuickControlButton")?.addEventListener("click", toggleQuickControl);
  $("settingsSpeechButton")?.addEventListener("click", toggleSpeech);
  $("settingsQuickSpeechButton")?.addEventListener("click", toggleQuickSpeech);
  $("settingsAutoResumeButton")?.addEventListener("click", toggleAutoResume);

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
    if (event.key === "Tab") return;
    handleSettingsControlKey(event);
    event.stopImmediatePropagation();
  }, true);

  $("settingsPanel")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) closeSettings();
  });

  ensureSpeechRateControl();
  syncQuickButtons();
  syncSettingsControls();
  waitForGameBindings();

  globalThis.__freeRoamSettings = {
    open: openSettings,
    close: closeSettings,
    setSpeechRate(rate) {
      preferences.speechRate = clampRate(rate);
      savePreferences();
      syncSpeechRateControl();
      return preferences.speechRate;
    },
    snapshot: () => ({
      ...preferences,
      gameButtonsEnabled: gameButtonsEnabled(),
      speechEnabled: speechEnabled(),
      speechRate: currentSpeechRate(),
    }),
  };
})();
