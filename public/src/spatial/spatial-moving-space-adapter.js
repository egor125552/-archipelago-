"use strict";

import {normalizeTransform} from "./spatial-contract.js";
import {
  composeTransforms,
  distance3d,
  inverseTransformPoint,
  normalizeYaw,
} from "./spatial-transform.js";

const COORDINATE_SPACES = new Set(["local", "world"]);

export function normalizeMovingSpaceSample(value, field = "movingSpace") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const coordinates = String(value.coordinates || "world");
  if (!COORDINATE_SPACES.has(coordinates)) throw new TypeError(`${field}.coordinates must be local or world`);
  const transform = normalizeTransform({
    position: value.position,
    yaw: value.yaw,
  }, `${field}.transform`);
  return Object.freeze({coordinates, transform});
}

function parentWorldTransform(runtime, space) {
  return space.parentSpaceId
    ? runtime.getSpaceWorldTransform(space.parentSpaceId)
    : runtime.location.worldTransform;
}

function worldToParentLocal(parentWorld, worldTransform) {
  return Object.freeze({
    position: inverseTransformPoint(parentWorld, worldTransform.position),
    yaw: normalizeYaw(worldTransform.yaw - parentWorld.yaw),
  });
}

function yawDistance(a, b) {
  return Math.abs(normalizeYaw(Number(a) - Number(b)));
}

export function applyMovingSpaceSample(runtime, spaceId, value, {positionEpsilon = 1e-6, yawEpsilon = 1e-6} = {}) {
  if (!runtime?.location?.spacesById || typeof runtime.getSpaceWorldTransform !== "function" || typeof runtime.setSpaceTransform !== "function") {
    throw new TypeError("runtime must provide a compiled location and moving-space transform methods");
  }
  const space = runtime.location.spacesById.get(spaceId);
  if (!space) throw new Error(`unknown space ${spaceId}`);
  if (!space.moving) throw new Error(`space ${spaceId} is not declared moving`);

  const sample = normalizeMovingSpaceSample(value);
  const parentWorld = parentWorldTransform(runtime, space);
  const localTransform = sample.coordinates === "local"
    ? sample.transform
    : worldToParentLocal(parentWorld, sample.transform);
  const desiredWorld = composeTransforms(parentWorld, localTransform);
  const currentWorld = runtime.getSpaceWorldTransform(spaceId);
  const changed = distance3d(currentWorld.position, desiredWorld.position) > Math.max(0, Number(positionEpsilon) || 0)
    || yawDistance(currentWorld.yaw, desiredWorld.yaw) > Math.max(0, Number(yawEpsilon) || 0);

  if (changed) runtime.setSpaceTransform(spaceId, localTransform);
  return Object.freeze({
    changed,
    sample,
    localTransform: Object.freeze({
      position: Object.freeze({...localTransform.position}),
      yaw: localTransform.yaw,
    }),
    worldTransform: runtime.getSpaceWorldTransform(spaceId),
  });
}

export function createSpatialMovingSpaceAdapter({readTransform} = {}) {
  if (typeof readTransform !== "function") throw new TypeError("readTransform must be a function");
  return Object.freeze({
    sync(runtime, spaceId, context = {}) {
      return applyMovingSpaceSample(runtime, spaceId, readTransform(context, spaceId, runtime));
    },
  });
}
