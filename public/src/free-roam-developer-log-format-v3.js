"use strict";

export const DEVELOPER_LOG_FORMAT_V3 = "archipelago-developer-log-v3";

export const TRACK_FIELDS = Object.freeze([
  "x", "y", "heading", "speed", "mode", "state", "active", "destroyed",
  "alive", "health", "hull", "engineHealth", "turretHealth", "targetPlayer",
  "equipped", "ammo", "pistolAmmo", "lockedTargetId", "activeBoat", "present",
  "phase", "stage", "repairSystem", "repairProgress", "repairPlates", "tacticalMode",
  "suppressionPhase", "destination", "movementMode", "activeArmorIndex", "armorLayers",
  "turrets", "bombBayState", "bombCooldown", "salvoRemaining", "bulletCount",
  "pendingBombCount", "owner", "driver", "leak", "fuel", "water", "throttle", "sunk",
]);

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function stripEventEnvelope(event) {
  const result = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (key === "type" || key === "at") continue;
    if (key === "operationEvent" && value === true) continue;
    if (key === "text" && value === "") continue;
    result[key] = value;
  }
  return result;
}

export function encodeTrackDelta(previous, next) {
  const values = [];
  for (let index = 0; index < TRACK_FIELDS.length; index += 1) {
    const field = TRACK_FIELDS[index];
    if (previous && equal(previous[field], next?.[field])) continue;
    if (!previous && next?.[field] === undefined) continue;
    values.push(index, next?.[field] ?? null);
  }
  return values;
}

export function applyTrackDelta(previous, encoded) {
  const result = {...(previous || {})};
  for (let index = 0; index < (encoded || []).length; index += 2) {
    const field = TRACK_FIELDS[encoded[index]];
    if (field) result[field] = encoded[index + 1];
  }
  return result;
}

export function changedTrackSample(previous, next, tolerance = {}) {
  if (!previous) return true;
  const numericTolerance = {
    x: 0.04,
    y: 0.04,
    heading: 0.35,
    speed: 0.04,
    ...tolerance,
  };
  for (const field of TRACK_FIELDS) {
    const before = previous[field];
    const after = next?.[field];
    if (typeof before === "number" && typeof after === "number" && field in numericTolerance) {
      if (Math.abs(after - before) >= numericTolerance[field]) return true;
      continue;
    }
    if (!equal(before, after)) return true;
  }
  return false;
}

export function makeTrackSample(timeMs, previous, next) {
  return [Math.max(0, Math.round(Number(timeMs) || 0)), ...encodeTrackDelta(previous, next)];
}

export function decodeTrackSamples(samples) {
  const result = [];
  let previous = null;
  for (const sample of samples || []) {
    const timeMs = Number(sample?.[0]) || 0;
    previous = applyTrackDelta(previous, sample?.slice(1));
    result.push({timeMs, ...previous});
  }
  return result;
}

export function summarizeAggregate(aggregate) {
  if (!aggregate) return null;
  return [
    aggregate.type,
    aggregate.firstAt ?? null,
    aggregate.lastAt ?? null,
    aggregate.count || 0,
    aggregate.damage || 0,
    aggregate.firstProjectileId ?? null,
    aggregate.lastProjectileId ?? null,
    aggregate.turretId ?? null,
    aggregate.weapon ?? null,
    aggregate.reason ?? null,
    aggregate.sourcePlayer ?? null,
    aggregate.targetPlayer ?? null,
    aggregate.targetId ?? null,
    aggregate.firstX ?? null,
    aggregate.firstY ?? null,
    aggregate.lastX ?? null,
    aggregate.lastY ?? null,
    aggregate.hits || 0,
    aggregate.misses || 0,
  ];
}

export function restoreAggregate(row) {
  if (!Array.isArray(row)) return null;
  const [
    type, firstAt, lastAt, count, damage, firstProjectileId, lastProjectileId,
    turretId, weapon, reason, sourcePlayer, targetPlayer, targetId,
    firstX, firstY, lastX, lastY, hits, misses,
  ] = row;
  return {
    type, firstAt, lastAt, count, damage, firstProjectileId, lastProjectileId,
    turretId, weapon, reason, sourcePlayer, targetPlayer, targetId,
    firstX, firstY, lastX, lastY, hits, misses,
  };
}
