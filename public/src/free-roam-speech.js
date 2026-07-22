"use strict";

const normalize = value => String(value || "").toLowerCase().replace(/ё/g, "е");

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
  rate = 1.18,
  onIdle = () => {},
} = {}) {
  let enabled = true;
  let selectedVoice = null;
  let activeToken = 0;
  let activeText = "";
  let watchdog = 0;
  let primed = false;

  const available = Boolean(synth && Utterance);

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
    if (!enabled || !available || !normalized) return false;
    refreshVoice();
    synth.resume?.();
    const token = ++activeToken;
    activeText = normalized;
    const utterance = new Utterance(normalized);
    utterance.lang = "ru-RU";
    utterance.rate = rate;
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

    // Match the original free-roam speech behaviour: there is no application
    // speech queue. A newer game message immediately replaces the phrase that
    // is currently being spoken, so an old position or combat report can
    // never be heard after the situation has already changed. `interrupt`
    // remains accepted for API compatibility; every announcement is fresh.
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

  function prime() {
    if (!enabled || !available) return;
    synth.resume?.();
    if (primed) return;
    primed = true;
    try {
      const utterance = new Utterance(".");
      utterance.lang = "ru-RU";
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
    get enabled() { return enabled; },
    get activeText() { return activeText; },
    // Kept for diagnostics compatibility. The queue itself no longer exists.
    get pendingText() { return ""; },
    get voice() { return selectedVoice; },
  };
}
