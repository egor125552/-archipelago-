"use strict";

// Compact structural patches used after the first authoritative world state.
// 0 = replace, 1 = object keys, 2 = array indexes. A null patch means no change.
const REPLACE = 0;
const OBJECT = 1;
const ARRAY = 2;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000) / 1_000;
}

function cloneValue(value) {
  if (typeof value === "number") return compactNumber(value);
  if (!isObject(value)) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const clone = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
  return clone;
}

function syncNode(current, baseline) {
  if (typeof current === "number") current = compactNumber(current);
  if (Object.is(current, baseline)) return {patch: null, next: baseline};
  if (!isObject(current) || !isObject(baseline) || Array.isArray(current) !== Array.isArray(baseline)) {
    const next = cloneValue(current);
    return {patch: [REPLACE, next], next};
  }

  if (Array.isArray(current)) {
    const changes = {};
    const previousLength = baseline.length;
    for (let index = 0; index < current.length; index += 1) {
      const result = syncNode(current[index], baseline[index]);
      if (result.patch !== null) {
        changes[index] = result.patch;
        baseline[index] = result.next;
      }
    }
    if (baseline.length !== current.length) baseline.length = current.length;
    if (previousLength === current.length && Object.keys(changes).length === 0) {
      return {patch: null, next: baseline};
    }
    return {patch: [ARRAY, current.length, changes], next: baseline};
  }

  const changes = {};
  const removed = [];
  for (const key of Object.keys(baseline)) {
    if (Object.hasOwn(current, key)) continue;
    delete baseline[key];
    removed.push(key);
  }
  for (const [key, value] of Object.entries(current)) {
    const result = syncNode(value, baseline[key]);
    if (result.patch === null) continue;
    changes[key] = result.patch;
    baseline[key] = result.next;
  }
  if (removed.length === 0 && Object.keys(changes).length === 0) {
    return {patch: null, next: baseline};
  }
  return {
    patch: removed.length ? [OBJECT, changes, removed] : [OBJECT, changes],
    next: baseline,
  };
}

export function createWorldDelta(current, baseline) {
  if (!isObject(current) || !isObject(baseline)) return [REPLACE, cloneValue(current)];
  return syncNode(current, baseline).patch;
}

export function compactWorldSnapshot(snapshot) {
  return cloneValue(snapshot);
}

function select(source, keys) {
  if (!source) return source ?? null;
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

const BOAT_FIELDS = Object.freeze([
  "id", "owner", "driver", "x", "y", "heading", "speed", "throttle", "rudder",
  "hull", "armor", "armorMax", "water", "leak", "fuel", "engineTemp",
  "engineStalled", "pumpActive", "repairPatches", "hullRepairProgress",
  "emergencyActive", "emergencyRemaining", "restartProgress", "sunk", "moving",
  "floatingBrakeReadyAt", "refuelCanisters", "refuelActive", "refuelProgress",
  "engineServiceActive", "engineServiceProgress", "cargo", "cargoWeight", "cargoPumpBonus",
]);
const PLAYER_FIELDS = Object.freeze([
  "id", "mode", "activeBoat", "x", "y", "heading", "running", "airborne", "jumpHeight",
]);
const COMBAT_FIELDS = Object.freeze([
  "health", "alive", "respawnRemaining", "knockedDown", "knockdownRemaining", "stun",
  "stamina", "carriedCrate", "weapons", "equipped", "ammo", "injuryMix", "lockedTargetId",
]);
const PURSUER_FIELDS = Object.freeze([
  "id", "x", "y", "heading", "speed", "hull", "maxHull", "active", "destroyed", "targetPlayer",
]);
const GUNNER_FIELDS = Object.freeze([
  "id", "pursuerId", "targetPlayer", "x", "y", "heading", "health", "active", "destroyed", "returning",
]);

// The guest renders and announces this view but never simulates it. Excluding
// host-only inputs, AI cooldowns, collision caches and projectile velocities
// keeps combat updates small even when every enemy is firing.
export function createReplicatedWorld(world) {
  const activities = world?.freeActivities || {};
  const scenario = world?.freeScenario || {};
  const pursuers = world?.freePursuerSquad || {};
  const gunners = world?.freeHostileGunners || {};
  return {
    version: world?.version,
    time: world?.time,
    boats: (world?.boats || []).map(boat => select(boat, BOAT_FIELDS)),
    players: (world?.players || []).map(player => ({
      ...select(player, PLAYER_FIELDS),
      combat: select(player?.combat, COMBAT_FIELDS),
    })),
    tow: world?.tow ?? null,
    freeActivities: {
      presence: activities.presence,
      score: activities.score,
      delivered: activities.delivered,
      crates: activities.crates,
      marauder: select(activities.marauder, PURSUER_FIELDS),
    },
    freeScenario: select(scenario, [
      "phase", "warningUntil", "targets", "lockedTargetIds", "beaconUntil", "guideEnabled",
    ]),
    freePursuerSquad: {
      activated: pursuers.activated,
      assignments: pursuers.assignments,
      escorts: (pursuers.escorts || []).map(escort => select(escort, PURSUER_FIELDS)),
      projectiles: (pursuers.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    },
    freeHostileGunners: {
      gunners: (gunners.gunners || []).map(gunner => select(gunner, GUNNER_FIELDS)),
      projectiles: (gunners.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    },
  };
}

export function applyWorldDelta(target, patch) {
  if (patch === null) return target;
  if (!Array.isArray(patch)) throw new TypeError("Invalid world delta");
  const operation = patch[0];
  if (operation === REPLACE) return patch[1];

  if (operation === ARRAY) {
    const result = Array.isArray(target) ? target : [];
    const length = Math.max(0, Number(patch[1]) || 0);
    const changes = patch[2] || {};
    result.length = length;
    for (const [rawIndex, childPatch] of Object.entries(changes)) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= length) continue;
      result[index] = applyWorldDelta(result[index], childPatch);
    }
    return result;
  }

  if (operation === OBJECT) {
    const result = isObject(target) && !Array.isArray(target) ? target : {};
    for (const key of patch[2] || []) delete result[key];
    for (const [key, childPatch] of Object.entries(patch[1] || {})) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      result[key] = applyWorldDelta(result[key], childPatch);
    }
    return result;
  }

  throw new TypeError("Unknown world delta operation");
}
