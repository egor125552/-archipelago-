"use strict";

export const SPEECH_OUTPUT_MODE_KEY = "echo-free-roam-speech-output-mode-v1";
export const SPEECH_OUTPUT_GAME = "game";
export const SPEECH_OUTPUT_SCREENREADER = "screenreader";

export function normalizeSpeechOutputMode(value) {
  return value === SPEECH_OUTPUT_SCREENREADER ? SPEECH_OUTPUT_SCREENREADER : SPEECH_OUTPUT_GAME;
}

export function storedSpeechOutputMode(storage) {
  try { return normalizeSpeechOutputMode(storage?.getItem?.(SPEECH_OUTPUT_MODE_KEY)); }
  catch (_) { return SPEECH_OUTPUT_GAME; }
}

export function installSpeechOutputMode(global = globalThis) {
  if (!global || global.__echoSpeechOutputModeV1) return global?.__echoSpeechOutputModeV1 || null;

  let storage = null;
  try { storage = global.localStorage || null; } catch (_) {}
  const mode = () => storedSpeechOutputMode(storage);

  function save(nextMode) {
    const next = normalizeSpeechOutputMode(nextMode);
    try { storage?.setItem?.(SPEECH_OUTPUT_MODE_KEY, next); } catch (_) {}
    if (next === SPEECH_OUTPUT_SCREENREADER) {
      try { global.speechSynthesis?.cancel?.(); } catch (_) {}
    }
    syncUi();
    try {
      global.dispatchEvent?.(new CustomEvent("echo-speech-output-mode-change", {detail: {mode: next}}));
    } catch (_) {}
    return next;
  }

  function speechGroup() {
    return global.document?.getElementById?.("settingsSpeechButton")?.closest?.(".settings-group") || null;
  }

  function ensureUi() {
    const document = global.document;
    const group = speechGroup();
    if (!document || !group) return null;
    let button = document.getElementById("settingsSpeechOutputButton");
    if (!button) {
      button = document.createElement("button");
      button.id = "settingsSpeechOutputButton";
      button.type = "button";
      button.setAttribute("aria-describedby", "settingsSpeechOutputHint");
      const grid = group.querySelector?.(".settings-grid");
      (grid || group).appendChild(button);
      button.addEventListener("click", () => {
        save(mode() === SPEECH_OUTPUT_SCREENREADER ? SPEECH_OUTPUT_GAME : SPEECH_OUTPUT_SCREENREADER);
      });
    }

    let hint = document.getElementById("settingsSpeechOutputHint");
    if (!hint) {
      hint = document.createElement("p");
      hint.id = "settingsSpeechOutputHint";
      hint.className = "settings-note";
      group.appendChild(hint);
    }
    return button;
  }

  function syncUi() {
    const button = ensureUi();
    const document = global.document;
    if (!button || !document) return;
    const screenReader = mode() === SPEECH_OUTPUT_SCREENREADER;
    button.textContent = `Способ озвучки: ${screenReader ? "скринридер" : "голос игры"}`;
    button.setAttribute("aria-label", screenReader
      ? "Способ озвучки: скринридер. Нажми, чтобы использовать голос игры."
      : "Способ озвучки: голос игры. Нажми, чтобы использовать скринридер.");
    button.dataset.mode = screenReader ? SPEECH_OUTPUT_SCREENREADER : SPEECH_OUTPUT_GAME;

    const rate = document.querySelector?.(".speech-rate-setting");
    if (rate) rate.hidden = screenReader;
    const hint = document.getElementById("settingsSpeechOutputHint");
    if (hint) {
      hint.textContent = screenReader
        ? "Игровые сообщения передаются в запущенный скринридер через доступное live-сообщение. Голос, скорость и высота берутся из настроек NVDA, VoiceOver или другого скринридера."
        : "Голос игры использует встроенный синтез речи браузера. Его скорость настраивается ползунком ниже.";
    }
  }

  const synth = global.speechSynthesis;
  if (synth && typeof synth.speak === "function" && !synth.__echoSpeechOutputModeWrappedV1) {
    const previousSpeak = synth.speak.bind(synth);
    const wrappedSpeak = utterance => {
      if (mode() === SPEECH_OUTPUT_SCREENREADER) {
        // The same game announcement is already exposed through #live. In this
        // mode the screen reader owns speech, so Web Speech must stay silent to
        // avoid two voices. Complete the utterance lifecycle immediately so the
        // game's speech controller never waits for a browser onend callback.
        queueMicrotask(() => {
          try { utterance?.onend?.({type: "end", screenReaderOutput: true}); } catch (_) {}
        });
        return undefined;
      }
      return previousSpeak(utterance);
    };
    try {
      Object.defineProperty(synth, "speak", {configurable: true, value: wrappedSpeak});
      Object.defineProperty(synth, "__echoSpeechOutputModeWrappedV1", {configurable: true, value: true});
    } catch (_) {
      try {
        synth.speak = wrappedSpeak;
        synth.__echoSpeechOutputModeWrappedV1 = true;
      } catch (_) {}
    }
  }

  const api = Object.freeze({
    mode,
    setMode: save,
    syncUi,
    get usesScreenReader() { return mode() === SPEECH_OUTPUT_SCREENREADER; },
  });
  try { Object.defineProperty(global, "__echoSpeechOutputModeV1", {configurable: true, value: api}); }
  catch (_) { global.__echoSpeechOutputModeV1 = api; }

  ensureUi();
  syncUi();
  return api;
}

if (typeof window !== "undefined") installSpeechOutputMode(globalThis);
