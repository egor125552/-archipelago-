"use strict";

function radians(degrees) {
  return degrees * Math.PI / 180;
}

export function normalizeYaw(value) {
  const number = Number(value) || 0;
  return ((number + 180) % 360 + 360) % 360 - 180;
}

export function rotateAroundZ(point, yaw) {
  const angle = radians(yaw);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
    z: point.z,
  };
}

export function composeTransforms(parent, local) {
  const rotated = rotateAroundZ(local.position, parent.yaw);
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    yaw: normalizeYaw(parent.yaw + local.yaw),
  };
}

export function transformPoint(transform, point) {
  const rotated = rotateAroundZ(point, transform.yaw);
  return {
    x: transform.position.x + rotated.x,
    y: transform.position.y + rotated.y,
    z: transform.position.z + rotated.z,
  };
}

export function inverseTransformPoint(transform, point) {
  const translated = {
    x: point.x - transform.position.x,
    y: point.y - transform.position.y,
    z: point.z - transform.position.z,
  };
  return rotateAroundZ(translated, -transform.yaw);
}

export function distance3d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function pointInPolygon2d(point, polygon) {
  const points = polygon.outer || polygon;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    const onBoundary = Math.abs(cross) <= 1e-9 && point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9 && point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9;
    if (onBoundary) return true;
    const crosses = ((a.y > point.y) !== (b.y > point.y)) && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (crosses) inside = !inside;
  }
  return inside;
}

export function spaceContainsLocalPoint(space, point, tolerance = 1e-6) {
  if (!space || !point) return false;
  if (point.z < space.shape.minZ - tolerance || point.z > space.shape.maxZ + tolerance) return false;
  return pointInPolygon2d(point, space.shape);
}

export function resolveSpaceWorldTransform(location, spaceId, dynamicTransforms = new Map()) {
  const spacesById = location.spacesById || new Map(location.spaces.map(space => [space.id, space]));
  const cache = new Map();
  const resolving = new Set();

  function resolve(id) {
    if (cache.has(id)) return cache.get(id);
    if (resolving.has(id)) throw new Error(`space transform cycle at ${id}`);
    const space = spacesById.get(id);
    if (!space) throw new Error(`unknown space ${id}`);
    resolving.add(id);
    const local = dynamicTransforms.get(id) || space.transform;
    const parent = space.parentSpaceId ? resolve(space.parentSpaceId) : location.worldTransform;
    const result = composeTransforms(parent, local);
    resolving.delete(id);
    cache.set(id, result);
    return result;
  }

  return resolve(spaceId);
}

export function localToWorld(location, spaceId, localPoint, dynamicTransforms = new Map()) {
  return transformPoint(resolveSpaceWorldTransform(location, spaceId, dynamicTransforms), localPoint);
}

export function worldToLocal(location, spaceId, worldPoint, dynamicTransforms = new Map()) {
  return inverseTransformPoint(resolveSpaceWorldTransform(location, spaceId, dynamicTransforms), worldPoint);
}

export function nearestPointDistance(location, a, b, dynamicTransforms = new Map()) {
  const worldA = localToWorld(location, a.spaceId, a.position, dynamicTransforms);
  const worldB = localToWorld(location, b.spaceId, b.position, dynamicTransforms);
  return distance3d(worldA, worldB);
}
