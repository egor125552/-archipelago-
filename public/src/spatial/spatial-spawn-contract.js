"use strict";

import {assertSpatialId, cloneSpatialData, normalizeVec3} from "./spatial-contract.js";

export class SpatialSpawnError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpatialSpawnError";
    this.details = details;
  }
}

function finiteOptional(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SpatialSpawnError(`${field} must be finite`, {field, value});
  return number;
}

export function normalizeSpawnDestination(value, field = "spawn") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpatialSpawnError(`${field} must be an object`, {field, value});
  }
  const id = assertSpatialId(value.id, `${field}.id`);
  const label = String(value.label || id).trim();
  if (!label) throw new SpatialSpawnError(`${field}.label is required`, {field, id});
  const position = normalizeVec3(value.position, `${field}.position`);
  const heading = finiteOptional(value.heading, `${field}.heading`);
  const mode = value.mode == null ? null : String(value.mode);
  const locationId = value.locationId == null ? null : assertSpatialId(value.locationId, `${field}.locationId`);
  const spaceId = value.spaceId == null ? null : assertSpatialId(value.spaceId, `${field}.spaceId`);
  return Object.freeze({
    id,
    label,
    position,
    heading,
    mode,
    locationId,
    spaceId,
    data: Object.freeze(cloneSpatialData(value.data || {})),
  });
}

export function selectSafeSpawn(candidates, {isSafe = () => true, score = () => 0} = {}) {
  const normalized = [...(candidates || [])].map((candidate, index) => normalizeSpawnDestination(candidate, `spawn[${index}]`));
  const valid = normalized.filter(candidate => isSafe(candidate) !== false);
  if (!valid.length) return null;
  valid.sort((a, b) => Number(score(a) || 0) - Number(score(b) || 0));
  return valid[0];
}

export function requireSafeSpawn(candidates, options = {}) {
  const spawn = selectSafeSpawn(candidates, options);
  if (spawn) return spawn;
  throw new SpatialSpawnError("no safe spawn destination is available", {
    candidateIds: [...(candidates || [])].map(candidate => String(candidate?.id || "unknown")),
  });
}

export function resolveDeclaredSpawn(location, spawnId, {findAnchor = null, isSafe = null} = {}) {
  const spawn = location?.spawnsById?.get?.(spawnId) || location?.spawns?.find?.(entry => entry.id === spawnId) || null;
  if (!spawn) return null;

  let position = spawn.position || null;
  if (spawn.anchorId) {
    const entry = typeof findAnchor === "function"
      ? findAnchor(spawn.anchorId, spawn.spaceId)
      : location?.anchorsById?.get?.(spawn.anchorId) || null;
    const anchor = entry?.anchor || entry;
    const ownerSpaceId = entry?.spaceId || spawn.spaceId;
    if (!anchor || ownerSpaceId !== spawn.spaceId || anchor.safe === false) return null;
    position = anchor.position || null;
  }
  if (!position) return null;

  const candidate = normalizeSpawnDestination({
    id: spawn.id,
    label: spawn.label || spawn.presentation?.label || spawn.id,
    locationId: location.id,
    spaceId: spawn.spaceId,
    position,
    heading: spawn.heading,
    mode: spawn.mode || "foot",
    data: {anchorId: spawn.anchorId || null},
  });
  if (typeof isSafe === "function" && isSafe(candidate) === false) return null;
  return candidate;
}
