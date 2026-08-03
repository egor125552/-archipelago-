"use strict";

import "./free-roam-speech-runtime-v2.js?v=2";
import "./free-roam-combat-experience-v2.js?v=1";

function targetMenuPhrase(text) {
  const value = String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  return /^(выбор цели\.|боевая цель\.|цель \d+ из|навигация \d+ из|живых боевых целей|доступных целей|цель подтвердить нельзя|навожусь на цель|навигационная цель выбрана)/.test(value);
}

function installTargetMenuSpeechBypass() {
  const synth = globalThis.speechSynthesis;
  const runtime = synth?.__echoSpeechRuntimeV2State;
  if (!synth || !runtime?.speak || synth.__echoTargetMenuSpeechBypassInstalled) return;
  const filteredSpeak = synth.speak?.bind?.(synth);
  if (!filteredSpeak) return;
  const speak = utterance => targetMenuPhrase(utterance?.text)
    ? runtime.speak(utterance)
    : filteredSpeak(utterance);
  try {
    Object.defineProperty(synth, "speak", {configurable: true, value: speak});
    Object.defineProperty(synth, "__echoTargetMenuSpeechBypassInstalled", {configurable: true, value: true});
  } catch (_) {
    try {
      synth.speak = speak;
      synth.__echoTargetMenuSpeechBypassInstalled = true;
    } catch (_) {}
  }
}

function refreshCombatStatusLabel() {
  const button = document.getElementById("combatGuidance-combatStatus");
  if (button) {
    const enabled = button.getAttribute("aria-pressed") === "true";
    const nextText = `Попадания по врагам и остаток прочности: ${enabled ? "озвучивать" : "не озвучивать"}`;
    if (button.textContent !== nextText) button.textContent = nextText;
  }
  const section = document.getElementById("combatGuidanceSettings");
  if (section && !document.getElementById("combatGuidanceTargetNote")) {
    const note = document.createElement("p");
    note.id = "combatGuidanceTargetNote";
    note.className = "settings-note";
    note.textContent = "Меню выбора целей озвучивается всегда и не зависит от фильтра попаданий.";
    section.append(note);
  }
}

installTargetMenuSpeechBypass();
queueMicrotask(refreshCombatStatusLabel);
setTimeout(refreshCombatStatusLabel, 0);

const panel = document.getElementById("settingsPanel");
if (panel) {
  const observer = new MutationObserver(() => {
    if (!panel.hidden) queueMicrotask(refreshCombatStatusLabel);
  });
  observer.observe(panel, {attributes: true, attributeFilter: ["hidden"]});
}
