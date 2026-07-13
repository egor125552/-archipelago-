"use strict";

export const PROFILE_KEY = "echo-archipelago-profile-v1";

export const OPERATIONS = Object.freeze([
  Object.freeze({id: 1, name: "Тихая бухта", description: "Учебная спасательная операция с открытыми прямыми маршрутами."}),
  Object.freeze({id: 2, name: "Проход среди обломков", description: "Два узких, но честных прохода. Магазин спасслужбы уже доступен."}),
  Object.freeze({id: 3, name: "Северный фарватер", description: "Два поля обломков и новый устойчивый катер «Касатка»."}),
]);

export const SHOP_ITEMS = Object.freeze([
  Object.freeze({
    id: "coast-brake",
    name: "Береговой автотормоз",
    cost: 650,
    unlockLevel: 2,
    description: "Через пять секунд после отпускания газа полностью останавливает лодку.",
  }),
  Object.freeze({
    id: "mini-armor",
    name: "Мини-броня",
    cost: 750,
    unlockLevel: 2,
    description: "Даёт 30 единиц брони на каждую операцию и принимает почти половину удара.",
  }),
  Object.freeze({
    id: "high-flow-pump",
    name: "Усиленная помпа",
    cost: 500,
    unlockLevel: 2,
    description: "Откачивает воду примерно на треть быстрее.",
  }),
]);

export const BOATS = Object.freeze([
  Object.freeze({id: "strizh", name: "Катер «Стриж»", unlockLevel: 1, description: "Быстрый базовый спасательный катер."}),
  Object.freeze({id: "kasatka", name: "Катер «Касатка»", unlockLevel: 3, description: "Более спокойный мотор, устойчивый корпус и меньше перегрева."}),
]);

function integer(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function createDefaultProfile() {
  return {
    version: 1,
    credits: 0,
    unlockedLevel: 1,
    selectedLevel: 1,
    selectedBoat: "strizh",
    ownedUpgrades: [],
    runs: 0,
    wins: 0,
    bestScore: 0,
    bestByLevel: {1: 0, 2: 0, 3: 0},
  };
}

export function normalizeProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  const profile = createDefaultProfile();
  profile.credits = integer(source.credits, 0, 0, 999_999);
  profile.unlockedLevel = integer(source.unlockedLevel, 1, 1, OPERATIONS.length);
  profile.selectedLevel = integer(source.selectedLevel, 1, 1, profile.unlockedLevel);
  profile.ownedUpgrades = [...new Set(Array.isArray(source.ownedUpgrades) ? source.ownedUpgrades : [])]
    .filter(id => SHOP_ITEMS.some(item => item.id === id));
  const boat = BOATS.find(item => item.id === source.selectedBoat && item.unlockLevel <= profile.unlockedLevel);
  profile.selectedBoat = boat?.id || "strizh";
  profile.runs = integer(source.runs, 0);
  profile.wins = integer(source.wins, 0, 0, profile.runs);
  profile.bestScore = integer(source.bestScore, 0);
  profile.bestByLevel = Object.fromEntries(OPERATIONS.map(operation => [
    operation.id,
    integer(source.bestByLevel?.[operation.id], 0),
  ]));
  return profile;
}

export function loadProfile(storage = globalThis.localStorage) {
  try {
    return normalizeProfile(JSON.parse(storage?.getItem(PROFILE_KEY) || "null"));
  } catch (_) {
    return createDefaultProfile();
  }
}

export function saveProfile(profile, storage = globalThis.localStorage) {
  const safe = normalizeProfile(profile);
  try { storage?.setItem(PROFILE_KEY, JSON.stringify(safe)); } catch (_) {}
  return safe;
}

export function selectOperation(profile, level) {
  const next = normalizeProfile(profile);
  next.selectedLevel = integer(level, next.selectedLevel, 1, next.unlockedLevel);
  return next;
}

export function selectBoat(profile, boatId) {
  const next = normalizeProfile(profile);
  const boat = BOATS.find(item => item.id === boatId && item.unlockLevel <= next.unlockedLevel);
  if (boat) next.selectedBoat = boat.id;
  return next;
}

export function purchaseUpgrade(profile, itemId) {
  const next = normalizeProfile(profile);
  const item = SHOP_ITEMS.find(candidate => candidate.id === itemId);
  if (!item) return {ok: false, reason: "unknown", profile: next};
  if (next.unlockedLevel < item.unlockLevel) return {ok: false, reason: "locked", profile: next, item};
  if (next.ownedUpgrades.includes(item.id)) return {ok: false, reason: "owned", profile: next, item};
  if (next.credits < item.cost) return {ok: false, reason: "credits", profile: next, item};
  next.credits -= item.cost;
  next.ownedUpgrades.push(item.id);
  return {ok: true, profile: normalizeProfile(next), item};
}

export function recordOperation(profile, {level, won, reward = 0, score = 0} = {}) {
  const next = normalizeProfile(profile);
  const operationLevel = integer(level, 1, 1, OPERATIONS.length);
  next.runs += 1;
  if (won) {
    next.wins += 1;
    next.credits += integer(reward, 0, 0, 99_999);
    next.bestScore = Math.max(next.bestScore, integer(score, 0));
    next.bestByLevel[operationLevel] = Math.max(next.bestByLevel[operationLevel], integer(score, 0));
    next.unlockedLevel = Math.max(next.unlockedLevel, Math.min(OPERATIONS.length, operationLevel + 1));
    next.selectedLevel = Math.min(next.unlockedLevel, operationLevel + 1);
  } else {
    next.selectedLevel = operationLevel;
  }
  return normalizeProfile(next);
}

export function runLoadout(profile) {
  const safe = normalizeProfile(profile);
  return {
    level: safe.selectedLevel,
    boatId: safe.selectedBoat,
    upgrades: Object.fromEntries(SHOP_ITEMS.map(item => [item.id, safe.ownedUpgrades.includes(item.id)])),
  };
}
