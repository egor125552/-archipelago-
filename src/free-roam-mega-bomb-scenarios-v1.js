"use strict";

export const SCENARIO_LAND_RECT = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
export const SCENARIO_SHORE_WALL_HEIGHT = 2.8;
export const WATER_SKIP_MIN_SPEED = 34;
export const WATER_SKIP_MAX_SLOPE = 0.29;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function pointInsideScenarioLand(point, rect = SCENARIO_LAND_RECT) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

export function predictProjectile(projectile, seconds = 0.05) {
  return {
    x: (Number(projectile?.x) || 0) + (Number(projectile?.vx) || 0) * seconds,
    y: (Number(projectile?.y) || 0) + (Number(projectile?.vy) || 0) * seconds,
    z: (Number(projectile?.z) || 0) + (Number(projectile?.vz) || 0) * seconds
      - 8.25 * seconds * seconds,
  };
}

function shoreNormal(current, next, rect = SCENARIO_LAND_RECT) {
  if (current.x < rect.minX && next.x >= rect.minX) return {nx: -1, ny: 0};
  if (current.x > rect.maxX && next.x <= rect.maxX) return {nx: 1, ny: 0};
  if (current.y < rect.minY && next.y >= rect.minY) return {nx: 0, ny: -1};
  if (current.y > rect.maxY && next.y <= rect.maxY) return {nx: 0, ny: 1};
  if (current.x >= rect.minX && next.x < rect.minX) return {nx: 1, ny: 0};
  if (current.x <= rect.maxX && next.x > rect.maxX) return {nx: -1, ny: 0};
  if (current.y >= rect.minY && next.y < rect.minY) return {nx: 0, ny: 1};
  if (current.y <= rect.maxY && next.y > rect.maxY) return {nx: 0, ny: -1};
  return null;
}

export function shoreImpactMode(projectile, seconds = 0.05) {
  const next = predictProjectile(projectile, seconds);
  if (pointInsideScenarioLand(projectile) === pointInsideScenarioLand(next)) return "none";
  if (Math.min(Number(projectile?.z) || 0, next.z) > SCENARIO_SHORE_WALL_HEIGHT) return "over";
  const normal = shoreNormal(projectile, next);
  if (!normal) return "none";
  const vx = Number(projectile?.vx) || 0;
  const vy = Number(projectile?.vy) || 0;
  const horizontal = Math.hypot(vx, vy) || 1;
  const incidence = Math.abs(vx * normal.nx + vy * normal.ny) / horizontal;
  if (incidence >= 0.68 || horizontal < 17) return "impact";
  if (incidence <= 0.3 && Number(projectile?.energy) > 0.32) return "ricochet";
  return Number(projectile?.energy) >= 0.22 ? "ricochet" : "impact";
}

export function waterSkipEligible(projectile, seconds = 0.05) {
  if (!projectile?.armed || pointInsideScenarioLand(projectile)) return false;
  if ((Number(projectile.waterSkipCooldownUntil) || 0) > (Number(projectile.age) || 0)) return false;
  const next = predictProjectile(projectile, seconds);
  const vz = Number(projectile.vz) || 0;
  if (next.z > 0 || vz >= -0.5) return false;
  const horizontal = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
  const slope = Math.abs(vz) / Math.max(1, horizontal);
  return horizontal >= WATER_SKIP_MIN_SPEED && slope <= WATER_SKIP_MAX_SLOPE
    && (Number(projectile.bounces) || 0) < 2 && Number(projectile.energy) >= 0.34;
}

export function closestApproach(a, b, seconds = 0.05) {
  const rx = (Number(b?.x) || 0) - (Number(a?.x) || 0);
  const ry = (Number(b?.y) || 0) - (Number(a?.y) || 0);
  const rz = (Number(b?.z) || 0) - (Number(a?.z) || 0);
  const vx = (Number(b?.vx) || 0) - (Number(a?.vx) || 0);
  const vy = (Number(b?.vy) || 0) - (Number(a?.y) || 0);
  const vz = (Number(b?.vz) || 0) - (Number(a?.vz) || 0);
  const speedSquared = vy * vx + vy * vy + vz * vz;
  const time = speedSquared > 1e-6
    ? slamp(-(rx * vx + ry * vy + rz * vz) / speedSquared, 0, seconds)
    : 0;
  return {time, distance: Math.hypot(rx + vx * time, ry + vy * time, rz + vz * time)};
}

export function impactRadius(target) {
  if (["heavyHull", "heavyEngine", "heavyTurret"].includes(target?.kind)) return 8.8;
  if (["boat", "marauder", "escort", "enemyBoat"].includes(target?.kind)) return 5.8;
  if (["player", "elite"].includes(target?.kind)) return 2.8;
  return 2.35;
}
