"use strict";

const DEFAULT_RESET_MS = 72;
const MAX_RESET_MS = 280;

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function installSpeechRuntimeV2(
  synth = globalThis.speechSynthesis,
  {
    resetMs = DEFAULT_RESET_MS,
    maxResetMs = MAX_RESET_MS,
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
  const minimumDelay = Math.max(24, Number(resetMs) || DEFAULT_RESET_MS);
  const maximumDelay = Math.max(minimumDelay, Number(maxResetMs) || MAX_RESET_MS);

  let generation = 0;
  let lastCancelAt = -Infinity;
  let pending = null;
  let timer = 0;
  let retries = 0;
  let spokenCount = 0;
  let canceledCount = 0;
  let droppedCount = 0;

  function clearPending(countAsDrop = false) {
    if (timer) clearTimer(timer);
    timer = 0;
    if (pending && countAsDrop) droppedCount += 1;
    pending = null;
    retries = 0;
  }

  function safeResume() {
    try { synth.resume?.(); } catch (_) {}
  }

  function nativeStart(utterance) {
    safeResume();
    try {
      nativeSpeak(utterance);
      spokenCount += 1;
      return true;
    } catch (_) {
      return false;
    }
  }

  function scheduleStart(expectedGeneration, delay = minimumDelay) {
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = 0;
      if (!pending || expectedGeneration !== generation) return;

      const elapsed = now() - lastCancelAt;
      const engineStillResetting = Boolean(synth.speaking || synth.pending || synth.paused);
      if (engineStillResetting && elapsed < maximumDelay) {
        safeResume();
        scheduleStart(expectedGeneration, Math.min(48, maximumDelay - elapsed));
        return;
      }

      const utterance = pending;
      pending = null;
      if (nativeStart(utterance)) {
        retries = 0;
        return;
      }

      if (retries < 1 && expectedGeneration === generation) {
        retries += 1;
        pending = utterance;
        scheduleStart(expectedGeneration, 90);
      } else {
        droppedCount += 1;
        retries = 0;
        try { utterance?.onerror?.({type: "error", error: "synthesis-failed"}); } catch (_) {}
      }
    }, Math.max(0, delay));
  }

  function reliableCancel() {
    generation += 1;
    lastCancelAt = now();
    canceledCount += 1;
    clearPending(true);
    safeResume();
    try { return nativeCancel(); }
    finally {
      setTimer(safeResume, 0);
    }
  }

  function reliableSpeak(utterance) {
    if (!utterance) return undefined;
    const elapsed = now() - lastCancelAt;
    const needsResetWindow = elapsed < minimumDelay || synth.speaking || synth.pending || synth.paused;
    if (!needsResetWindow) {
      nativeStart(utterance);
      return undefined;
    }

    if (pending) droppedCount += 1;
    pending = utterance;
    retries = 0;
    const wait = Math.max(0, minimumDelay - elapsed);
    scheduleStart(generation, wait);
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
      if (!pending) return false;
      const utterance = pending;
      clearPending(false);
      nativeStart(utterance);
      return true;
    },
    snapshot() {
      return {
        pending: Boolean(pending),
        speaking: Boolean(synth.speaking),
        nativePending: Boolean(synth.pending),
        paused: Boolean(synth.paused),
        generation,
        spokenCount,
        canceledCount,
        droppedCount,
      };
    },
    get pending() { return pending; },
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
