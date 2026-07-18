"use strict";

const speechState = {
  lastText: "",
  lastAt: -Infinity,
  fallbackCount: 0,
};

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function bestRussianVoice(synth) {
  const voices = synth.getVoices?.() || [];
  return voices
    .filter(voice => String(voice.lang || "").toLowerCase().startsWith("ru"))
    .sort((left, right) => {
      const score = voice => {
        const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
        let value = 10;
        if (/milena|милена/.test(name)) value += 1000;
        if (/enhanced|premium|improved|natural|neural|улучш/.test(name)) value += 500;
        if (/compact|компакт/.test(name)) value -= 200;
        return value;
      };
      return score(right) - score(left);
    })[0] || null;
}

function installSpeechFallback() {
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  const message = document.getElementById("message");
  if (!synth || !Utterance || !message) return;

  const originalSpeak = synth.speak.bind(synth);
  try {
    synth.speak = utterance => {
      speechState.lastText = normalizeText(utterance?.text);
      speechState.lastAt = performance.now();
      return originalSpeak(utterance);
    };
  } catch (_) {
    // Safari normally allows an instance method override. The observer below
    // still restores speech if a browser exposes the method as read-only.
  }

  const speakFallback = text => {
    const normalized = normalizeText(text);
    if (!normalized) return;
    const recentlySpoken = speechState.lastText === normalized
      && performance.now() - speechState.lastAt < 700;
    if (recentlySpoken) return;

    synth.cancel?.();
    const utterance = new Utterance(normalized);
    utterance.lang = "ru-RU";
    utterance.rate = 1.18;
    utterance.pitch = 1;
    const voice = bestRussianVoice(synth);
    if (voice) utterance.voice = voice;
    speechState.lastText = normalized;
    speechState.lastAt = performance.now();
    speechState.fallbackCount += 1;
    originalSpeak(utterance);
  };

  let previousText = normalizeText(message.textContent);
  const observer = new MutationObserver(() => {
    const nextText = normalizeText(message.textContent);
    if (!nextText || nextText === previousText) return;
    previousText = nextText;
    setTimeout(() => speakFallback(nextText), 80);
  });
  observer.observe(message, {childList: true, characterData: true, subtree: true});

  // Prime iOS speech synthesis during the first trusted user gesture without
  // producing an audible word. Later WebSocket announcements can then speak.
  const prime = () => {
    try {
      const utterance = new Utterance(".");
      utterance.lang = "ru-RU";
      utterance.volume = 0;
      originalSpeak(utterance);
    } catch (_) {}
  };
  document.addEventListener("pointerdown", prime, {capture: true, once: true});

  window.__freeRoamSpeech = speechState;
}

installSpeechFallback();
