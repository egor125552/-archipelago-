"use strict";

export function installSpeechReliability(
  synth = globalThis.speechSynthesis,
  {
    delayMs = 48,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
  } = {},
) {
  if (!synth || synth.__echoSpeechReliabilityInstalled) return synth?.__echoSpeechReliabilityState || null;
  if (typeof synth.speak !== "function" || typeof synth.cancel !== "function") return null;

  const originalSpeak = synth.speak.bind(synth);
  const originalCancel = synth.cancel.bind(synth);
  let generation = 0;
  let lastCancelAt = -Infinity;
  let pendingTimer = 0;
  let pendingUtterance = null;

  function clearPending() {
    if (pendingTimer) clearTimer(pendingTimer);
    pendingTimer = 0;
    pendingUtterance = null;
  }

  function reliableCancel() {
    generation += 1;
    lastCancelAt = now();
    clearPending();
    return originalCancel();
  }

  function reliableSpeak(utterance) {
    const wait = Math.max(0, Number(delayMs) - (now() - lastCancelAt));
    if (wait <= 0) return originalSpeak(utterance);

    // Safari and several Windows voices can drop an utterance when speak() is
    // called in the same task as cancel(). Keep only the newest game phrase
    // and start it after a tiny engine reset window.
    clearPending();
    const expectedGeneration = generation;
    pendingUtterance = utterance;
    pendingTimer = setTimer(() => {
      pendingTimer = 0;
      const latest = pendingUtterance;
      pendingUtterance = null;
      if (expectedGeneration !== generation || !latest) return;
      originalSpeak(latest);
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
      clearPending();
      originalSpeak(utterance);
      return true;
    },
    get pending() { return pendingUtterance; },
  };
  try {
    Object.defineProperty(synth, "__echoSpeechReliabilityInstalled", {configurable: true, value: true});
    Object.defineProperty(synth, "__echoSpeechReliabilityState", {configurable: true, value: state});
  } catch (_) {}
  return state;
}
