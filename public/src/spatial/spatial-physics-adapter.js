"use strict";

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return number;
}

function optionalFinite(value, field) {
  return value == null ? null : finite(value, field);
}

export function normalizeVerticalPhysicsSample(value, field = "verticalPhysics") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const supportLocalZ = finite(value.supportLocalZ, `${field}.supportLocalZ`);
  const offsetZ = finite(value.offsetZ, `${field}.offsetZ`);
  const velocityZ = optionalFinite(value.velocityZ, `${field}.velocityZ`);
  const airborne = value.airborne == null ? null : value.airborne;
  if (airborne != null && typeof airborne !== "boolean") throw new TypeError(`${field}.airborne must be boolean when provided`);
  return Object.freeze({
    supportLocalZ,
    offsetZ,
    localZ: supportLocalZ + offsetZ,
    velocityZ,
    airborne,
  });
}

export function applyVerticalPhysicsSample(runtime, entityId, value, {epsilon = 1e-6} = {}) {
  if (!runtime || typeof runtime.getEntity !== "function" || typeof runtime.moveEntity !== "function") {
    throw new TypeError("runtime must provide getEntity() and moveEntity()");
  }
  const threshold = Math.max(0, finite(epsilon, "epsilon"));
  const sample = normalizeVerticalPhysicsSample(value);
  const before = runtime.getEntity(entityId);
  if (!before) throw new Error(`unknown spatial entity ${entityId}`);

  const previousZ = finite(before.localPosition?.z, `entity ${entityId}.localPosition.z`);
  const changed = Math.abs(previousZ - sample.localZ) > threshold;
  const entity = changed
    ? runtime.moveEntity(entityId, {
        x: before.localPosition.x,
        y: before.localPosition.y,
        z: sample.localZ,
      })
    : before;
  const worldPosition = typeof runtime.getEntityWorldPosition === "function"
    ? runtime.getEntityWorldPosition(entityId)
    : null;

  return Object.freeze({
    changed,
    sample,
    entity,
    worldPosition,
  });
}

export function createSpatialVerticalPhysicsAdapter({readSample} = {}) {
  if (typeof readSample !== "function") throw new TypeError("readSample must be a function");
  return Object.freeze({
    sync(runtime, entityId, context = {}) {
      const sample = readSample(context, entityId, runtime);
      return applyVerticalPhysicsSample(runtime, entityId, sample);
    },
  });
}
