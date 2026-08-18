"use strict";

export function isTargetMenuSpeech(text) {
  const value = String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
  return /^(выбор цели\.|боевая цель\.|цель \d+ из|навигация \d+ из|локации(?:\.| \d+ из)|живых боевых целей|доступных целей|цель подтвердить нельзя|навожусь на цель|навигационная цель выбрана|локация выбрана)/.test(value);
}

export function targetMenuAwareSpeechAllowed(previousGate, text) {
  if (isTargetMenuSpeech(text)) return true;
  return typeof previousGate !== "function" || previousGate(text);
}

export function installTargetMenuSpeechGateBypass(target = globalThis) {
  const previousGate = target?.__echoFreeRoamSpeechAllowed;
  if (typeof previousGate !== "function") return false;
  if (previousGate.__echoTargetMenuSpeechGateBypassInstalled) return true;

  const gate = text => targetMenuAwareSpeechAllowed(previousGate, text);
  try {
    Object.defineProperty(gate, "__echoTargetMenuSpeechGateBypassInstalled", {value: true});
  } catch (_) {
    gate.__echoTargetMenuSpeechGateBypassInstalled = true;
  }
  target.__echoFreeRoamSpeechAllowed = gate;
  return target.__echoFreeRoamSpeechAllowed === gate;
}
