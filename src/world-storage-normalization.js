"use strict";

function numericObjectValues(value) {
  if (!value || typeof value !== "object") return null;
  if (value instanceof Map) return [...value.values()];
  const entries = Object.entries(value);
  if (!entries.length) return null;
  if (!entries.every(([key]) => /^(0|[1-9]\d*)$/.test(key))) return null;
  entries.sort((left, right) => Number(left[0]) - Number(right[0]));
  for (let index = 0; index < entries.length; index += 1) {
    if (Number(entries[index][0]) !== index) return null;
  }
  return entries.map(([, item]) => item);
}

export function storedList(value) {
  if (Array.isArray(value)) return value;
  return numericObjectValues(value) || [];
}

function reviveStoredValue(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const numeric = numericObjectValues(value);
  if (numeric) {
    const result = [];
    seen.set(value, result);
    for (const item of numeric) result.push(reviveStoredValue(item, seen));
    return result;
  }
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(reviveStoredValue(item, seen));
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = reviveStoredValue(item, seen);
  return result;
}

export function normalizePersistedFreeWorld(input) {
  const world = reviveStoredValue(input);
  if (!world || typeof world !== "object") return world;
  const paths = [
    [world, "players"], [world, "boats"], [world, "inputs"], [world, "previousInputs"],
    [world, "operationInputs"], [world, "operationPreviousInputs"], [world, "events"],
    [world.freeEnemyBoats, "boats"], [world.freeEnemyBoats, "projectiles"],
    [world.freeHostileActors, "actors"], [world.freeHostileActors, "projectiles"],
    [world.freeHostileGunners, "gunners"], [world.freeHostileGunners, "projectiles"],
    [world.freePursuerSquad, "escorts"], [world.freePursuerSquad, "projectiles"],
  ];
  for (const [owner, key] of paths) {
    if (owner && typeof owner === "object") owner[key] = storedList(owner[key]);
  }
  return world;
}
