"use strict";

const DEFAULT_RESET_MS = 80;

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function installSpeechRuntimeV2(
  synth = globalThis.speechSynthesis,
  {
    resetMs = DEFAULT_RESET_MS,
    now = clock,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
  } = {},
) {
  if (!synth) return null;
  if (synth.__echoSpeechRuntimeV2Installed) return synth.__echoSpeechRuntimeV2State || null;
  if (typeof synth.speak !== "function" || typeof synth.cancel !== "function") return null;

  const nativeSpeak = synth.speak.bind(synth);
  const nativeCancel = synth.cancel.bind(synth);
  const delay = Math.max(32, Math.min(160, Number(resetMs) || DEFAULT_RESET_MS));

  let generation = 0;
  let lastCancelAt = -Infinity;
  let pendingTimer = 0;
  let pendingUtterance = null;
  let spokenCount = 0;
  let canceledCount = 0;
  let replacedCount = 0;

  function clearPending(countReplacement = false) {
    if (pendingTimer) clearTimer(pendingTimer);
    pendingTimer = 0;
    if (pendingUtterance && countReplacement) replacedCount += 1;
    pendingUtterance = null;
  }

  function startNative(utterance) {
    if (!utterance) return false;
    try { synth.resume?.(); } catch (_) {}
    try {
      nativeSpeak(utterance);
      spokenCount += 1;
      return true;
    } catch (_) {
      try { utterance?.onerror?.({type: "error", error: "synthesis-failed"}); } catch (_) {}
      return false;
    }
  }

  function reliableCancel() {
    generation += 1;
    canceledCount += 1;
    lastCancelAt = now();
    clearPending(false);
    try { synth.resume?.(); } catch (_) {}
    return nativeCancel();
  }

  function reliableSpeak(utterance) {
    if (!utterance) return undefined;
    const wait = Math.max(0, delay - (now() - lastCancelAt));
    if (wait <= 0) {
      startNative(utterance);
      return undefined;
    }

    // Safari can discard speak() when it follows cancel() immediately.
    // Use exactly one bounded timer and keep only the newest requested phrase.
    clearPending(Boolean(pendingUtterance));
    const expectedGeneration = generation;
    pendingUtterance = utterance;
    pendingTimer = setTimer(() => {
      pendingTimer = 0;
      const latest = pendingUtterance;
      pendingUtterance = null;
      if (expectedGeneration !== generation || !latest) return;
      startNative(latest);
    }, wait);
    return undefined;
  }

  let installed = false;
  try {
    Object.defineProperty(synth, "cancel", {configurable: true, value: reliableCancel});
    Object.defineProperty(synth, "speak", {configurable: true, value: reliableSpeak});
    installed = true;
  } catch (_) {
    try {
      synth.cancel = reliableCancel;
      synth.speak = reliableSpeak;
      installed = synth.cancel === reliableCancel && synth.speak === reliableSpeak;
    } catch (_) {}
  }
  if (!installed) return null;

  const state = {
    cancel: reliableCancel,
    speak: reliableSpeak,
    flush() {
      if (!pendingUtterance) return false;
      const utterance = pendingUtterance;
      clearPending(false);
      return startNative(utterance);
    },
    snapshot() {
      return {
        pending: Boolean(pendingUtterance),
        generation,
        spokenCount,
        canceledCount,
        replacedCount,
      };
    },
    get pending() { return pendingUtterance; },
  };

  try {
    Object.defineProperty(synth, "__echoSpeechRuntimeV2Installed", {configurable: true, value: true});
    Object.defineProperty(synth, "__echoSpeechRuntimeV2State", {configurable: true, value: state});
    Object.defineProperty(synth, "__echoSpeechReliabilityInstalled", {configurable: true, value: true});
    Object.defineProperty(synth, "__echoSpeechReliabilityState", {configurable: true, value: state});
  } catch (_) {}

  globalThis.__echoSpeechRuntimeV2 = state;
  return state;
}

installSpeechRuntimeV2();
