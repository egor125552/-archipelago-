"use strict";

import {speechPolicyAllows} from "./free-roam-speech-policy.js?v=1";

const SPEECH_RATE_KEY = "echo-free-roam-speech-rate";
const DEFAULT_SPEECH_RATE = 1.18;
const normalize = value => String(value || "").toLowerCase().replace(/ё/g, "е");

export function clampSpeechRate(value, fallback = DEFAULT_SPEECH_RATE) {
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber) && fallbackNumber > 0
    ? Math.max(0.6, Math.min(2, fallbackNumber))
    : DEFAULT_SPEECH_RATE;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return safeFallback;
  return Math.max(0.6, Math.min(2, number));
}

export function storedSpeechRate(storage, fallback = DEFAULT_SPEECH_RATE) {
  try {
    const stored = storage?.getItem?.(SPEECH_RATE_KEY);
    if (stored == null || stored === "") return clampSpeechRate(fallback);
    return clampSpeechRate(stored, fallback);
  } catch (_) {
    return clampSpeechRate(fallback);
  }
}

export function russianVoiceScore(voice) {
  if (!normalize(voice?.lang).startsWith("ru")) return -10_000;
  const name = normalize(`${voice?.name || ""} ${voice?.voiceURI || ""}`);
  let score = 10;
  if (/milena|милена/.test(name)) score += 1000;
  if (/enhanced|premium|improved|natural|neural|улучш/.test(name)) score += 500;
  if (/compact|компакт/.test(name)) score -= 200;
  return score;
}

export function createSpeechController({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  rate = DEFAULT_SPEECH_RATE,
  storage,
  onIdle = () => {},
} = {}) {
  let enabled = true;
  let selectedVoice = null;
  let activeToken = 0;
  let activeText = "";
  let watchdog = 0;
  let primed = false;
  let currentRate = clampSpeechRate(rate);
  let speechRateStorage = storage;
  if (speechRateStorage === undefined) {
    try { speechRateStorage = globalThis.localStorage; }
    catch (_) { speechRateStorage = null; }
  }

  const available = Boolean(synth && Utterance);

  function resolveRate() {
    return storedSpeechRate(speechRateStorage, currentRate);
  }

  function allowed(text) {
    try { return speechPolicyAllows(text, {storage: speechRateStorage}); }
    catch (_) { return true; }
  }

  function refreshVoice() {
    if (!available) return null;
    selectedVoice = [...(synth.getVoices?.() || [])]
      .sort((left, right) => russianVoiceScore(right) - russianVoiceScore(left))[0] || null;
    return selectedVoice;
  }

  function clearWatchdog() {
    clearTimeout(watchdog);
    watchdog = 0;
  }

  function start(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!enabled || !available || !normalized || !allowed(normalized)) return false;
    refreshVoice();
    synth.resume?.();
    const token = ++activeToken;
    activeText = normalized;
    const utterance = new Utterance(normalized);
    utterance.lang = "ru-RU";
    utterance.rate = resolveRate();
    utterance.pitch = 1;
    if (selectedVoice) utterance.voice = selectedVoice;

    const finish = () => {
      if (token !== activeToken) return;
      clearWatchdog();
      activeText = "";
      onIdle();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    synth.speak(utterance);

    // Some Windows voices in Chrome omit onend/onerror. Never let one stuck
    // utterance disable all subsequent status and combat announcements.
    watchdog = setTimeout(() => {
      if (token !== activeToken) return;
      try { synth.cancel(); } catch (_) {}
      finish();
    }, Math.max(5_000, Math.min(20_000, normalized.length * 115)));
    return true;
  }

  function speak(text, {interrupt = false} = {}) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!enabled || !available || !normalized) return false;

    // Speech policy is evaluated before *any* replacement side effect. A muted
    // category is not a silent utterance: it is no utterance at all. It must not
    // cancel the phrase already in progress, invalidate its token, clear its
    // watchdog, or become the controller's active text.
    if (!allowed(normalized)) return false;

    // Match the original free-roam speech behaviour for phrases that are
    // actually enabled: there is no application speech queue. A newer allowed
    // game message immediately replaces the phrase currently being spoken.
    void interrupt;
    activeText = "";
    clearWatchdog();
    activeToken += 1;
    try { synth.cancel(); } catch (_) {}
    return start(normalized);
  }

  function cancel() {
    activeText = "";
    clearWatchdog();
    activeToken += 1;
    try { synth?.cancel?.(); } catch (_) {}
    onIdle();
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (!enabled) cancel();
    return enabled;
  }

  function setRate(nextRate) {
    currentRate = clampSpeechRate(nextRate, currentRate);
    return currentRate;
  }

  function prime() {
    if (!enabled || !available) return;
    synth.resume?.();
    if (primed) return;
    primed = true;
    try {
      const utterance = new Utterance(".");
      utterance.lang = "ru-RU";
      utterance.rate = resolveRate();
      utterance.volume = 0;
      synth.speak(utterance);
    } catch (_) {}
  }

  refreshVoice();
  synth?.addEventListener?.("voiceschanged", refreshVoice);

  return {
    available,
    speak,
    cancel,
    prime,
    refreshVoice,
    setEnabled,
    setRate,
    get enabled() { return enabled; },
    get activeText() { return activeText; },
    // Kept for diagnostics compatibility. The queue itself no longer exists.
    get pendingText() { return ""; },
    get rate() { return resolveRate(); },
    get voice() { return selectedVoice; },
  };
}
