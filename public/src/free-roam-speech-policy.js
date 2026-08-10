"use strict";

export const COMBAT_GUIDANCE_STORAGE_KEY = "echo-free-roam-combat-guidance-v1";

const EXPERIENCED = Object.freeze({
  profile: "experienced",
  death: false,
  threat: true,
  aim: true,
  playerHit: false,
  boatHit: true,
  repair: true,
  combatStatus: false,
});

const CATEGORY_KEYS = Object.freeze([
  "death",
  "threat",
  "aim",
  "playerHit",
  "boatHit",
  "repair",
  "combatStatus",
]);

const normalize = text => String(text || "")
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/\s+/g, " ")
  .trim();

function defaultStorage() {
  try { return globalThis.localStorage || null; }
  catch (_) { return null; }
}

export function targetMenuSpeech(text) {
  const value = normalize(text);
  return /^(выбор цели\.|боевая цель\.|цель \d+ из|навигация \d+ из|живых боевых целей|доступных целей|цель подтвердить нельзя|навожусь на цель|навигационная цель выбрана)/.test(value);
}

export function combatGuidanceCategory(text) {
  const value = normalize(text);
  if (!value || value === "." || targetMenuSpeech(value)) return null;
  if (/ты погиб|возрожд|игрок повержен|ты снова у причала|погиб\./.test(value)) return "death";
  if (/угроза [1-5]|уровень угрозы|в бухту вош|снаружи бухты|подкреплен|ударная группа|преследовател|элитный стрелок.*высад/.test(value)) return "threat";
  if (/навод|прицел|готовит удар|занес нож|длинная очередь|захват подтвержден/.test(value)) return "aim";
  if (/здоровье \d|тебя сбили|тебя ранил|попала в тебя|ударил тебя/.test(value)) return "playerHit";
  if (/попал[аио]? в (твою |вашу )?лодк|протаранил лодк|лодк.*корпус \d|корпус лодки/.test(value)) return "boatHit";
  if (/ремонт тяжелого катера|ремонтных пластин|катер.*чин|аварийный ремонт|уходит на максимальной скорости|ремонт .* завершен/.test(value)) return "repair";
  if (/^попадание|прочность \d|осталось \d|корпус преследователя|цель .* осталось/.test(value)) return "combatStatus";
  return null;
}

export function combatGuidancePreferences(storage = defaultStorage()) {
  try {
    const stored = JSON.parse(storage?.getItem?.(COMBAT_GUIDANCE_STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return {...EXPERIENCED};
    const result = {...EXPERIENCED};
    result.profile = ["beginner", "experienced", "custom"].includes(stored.profile)
      ? stored.profile
      : "custom";
    for (const key of CATEGORY_KEYS) {
      if (typeof stored[key] === "boolean") result[key] = stored[key];
    }
    return result;
  } catch (_) {
    return {...EXPERIENCED};
  }
}

export function speechPolicyAllows(text, {storage = defaultStorage()} = {}) {
  const category = combatGuidanceCategory(text);
  if (!category) return true;
  return combatGuidancePreferences(storage)[category] !== false;
}

try {
  Object.defineProperty(globalThis, "__echoSpeechPolicyV1", {
    configurable: true,
    value: Object.freeze({
      allows: speechPolicyAllows,
      categoryForText: combatGuidanceCategory,
      preferences: combatGuidancePreferences,
    }),
  });
} catch (_) {}
