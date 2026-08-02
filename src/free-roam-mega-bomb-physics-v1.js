"use strict";

export const MEGA_BOMB_WORLD_BOUNDS = Object.freeze({minX: 4, maxX: 416, minY: 4, maxY: 316});
export const MEGA_BOMB_LAND_RECT = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
export const MEGA_BOMB_GRAVITY = 16.5;
export const MEGA_BOMB_LAUNCH_SPEED = 48;
export const MEGA_BOMB_BOAT_INHERITANCE = 0.82;
export const MEGA_BOMB_SHORE_WALL_HEIGHT = 2.8;

const AIR_DRAG = 0.018;
const BOUNDARY_RESTITUTION = 0.58;
const SHORE_RESTITUTION = 0.52;
const TANGENTIAL_FRICTION = 0.84;
const MIN_RICOCHET_ENERGY = 0.22;
const MAX_RICOCHETS = 3;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
export const speed3 = value => Math.hypot(Number(value?.vx) || 0, Number(value?.vy) || 0, Number(value?.vz) || 0);
export const pointInsideRect = (point, rect = MEGA_BOMB_LAND_RECT) => {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
};

export function headingVector(heading) {
  const angle = (Number(heading) || 0) * Math.PI / 180;
  return {x: Math.sin(angle), y: -Math.cos(angle)};
}

export function bearing(from, to) {
  return Math.atan2(
    (Number(to?.x) || 0) - (Number(from?.x) || 0),
    -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
  ) * 180 / Math.PI;
}

export function sourceVelocity(source) {
  const direction = headingVector(source?.heading);
  const speed = Number(source?.speed) || 0;
  return {vx: direction.x * speed, vy: direction.y * speed};
}

function flightSolution(horizontalSpeed, intendedDistance) {
  const distance = clamp(intendedDistance, 18, 230);
  const time = clamp(distance / Math.max(18, horizontalSpeed), 1.05, 5.6);
  return {
    intendedDistance: distance,
    intendedFlightTime: time,
    vz: clamp(MEGA_BOMB_GRAVITY * time * 0.5 + 0.35 / time, 9.5, 33),
  };
}

export function createMegaBombProjectile({
  id,
  owner,
  start,
  heading,
  intendedDistance = 105,
  inheritedVelocity = {vx: 0, vy: 0},
  launchSpeed = MEGA_BOMB_LAUNCH_SPEED,
} = {}) {
  const direction = headingVector(heading);
  const ownVx = direction.x * launchSpeed;
  const ownVy = direction.y * launchSpeed;
  const vx = ownVx + (Number(inheritedVelocity?.vx) || 0) * MEGA_BOMB_BOAT_INHERITANCE;
  const vy = ownVy + (Number(inheritedVelocity?.vy) || 0) * MEGA_BOMB_BOAT_INHERITANCE;
  const solution = flightSolution(Math.hypot(vx, vy), intendedDistance);
  return {
    id: String(id || "mega-bomb"),
    owner: Number(owner) || 0,
    physicsVersion: 1,
    x: Number(start?.x) || 0,
    y: Number(start?.y) || 0,
    z: Math.max(1.8, Number(start?.z) || 2.2),
    vx,
    vy,
    vz: solution.vz,
    heading: bearing({x: 0, y: 0}, {x: vx, y: vy}),
    age: 0,
    maxAge: clamp(solution.intendedFlightTime + 3.2, 4.2, 9),
    intendedDistance: solution.intendedDistance,
    intendedFlightTime: solution.intendedFlightTime,
    distanceTravelled: 0,
    energy: 1,
    bounces: 0,
    armed: false,
    nextFlightAt: 0,
    lastCollision: null,
    launchSpeed: Math.hypot(vx, vy),
  };
}

function segmentBoundaryHit(a, b, rect = MEGA_BOMB_LAND_RECT) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const candidates = [];
  const push = (t, x, y, nx, ny) => {
    if (t < -1e-8 || t > 1 + 1e-8) return;
    if (x < rect.minX - 1e-7 || x > rect.maxX + 1e-7) return;
    if (y < rect.minY - 1e-7 || y > rect.maxY + 1e-7) return;
    candidates.push({t: clamp(t, 0, 1), x, y, nx, ny});
  };
  if (Math.abs(dx) > 1e-9) {
    let t = (rect.minX - a.x) / dx;
    push(t, rect.minX, a.y + dy * t, -1, 0);
    t = (rect.maxX - a.x) / dx;
    push(t, rect.maxX, a.y + dy * t, 1, 0);
  }
  if (Math.abs(dy) > 1e-9) {
    let t = (rect.minY - a.y) / dy;
    push(t, a.x + dx * t, rect.minY, 0, -1);
    t = (rect.maxY - a.y) / dy;
    push(t, a.x + dx * t, rect.maxY, 0, 1);
  }
  candidates.sort((left, right) => left.t - right.t);
  return candidates[0] || null;
}

function worldBoundaryHit(next, bounds = MEGA_BOMB_WORLD_BOUNDS) {
  if (next.x < bounds.minX) return {x: bounds.minX, y: clamp(next.y, bounds.minY, bounds.maxY), nx: 1, ny: 0};
  if (next.x > bounds.maxX) return {x: bounds.maxX, y: clamp(next.y, bounds.minY, bounds.maxY), nx: -1, ny: 0};
  if (next.y < bounds.minY) return {x: clamp(next.x, bounds.minX, bounds.maxX), y: bounds.minY, nx: 0, ny: 1};
  if (next.y > bounds.maxY) return {x: clamp(next.x, bounds.minX, bounds.maxX), y: bounds.maxY, nx: 0, ny: -1};
  return null;
}

function reflectHorizontal(projectile, normal, restitution, energyLoss) {
  const dot = projectile.vx * normal.nx + projectile.vy * normal.ny;
  const normalVx = dot * normal.nx;
  const normalVy = dot * normal.ny;
  const tangentVx = projectile.vx - normalVx;
  const tangentVy = projectile.vy - normalVy;
  projectile.vx = tangentVx * TANGENTIAL_FRICTION - normalVx * restitution;
  projectile.vy = tangentVy * TANGENTIAL_FRICTION - normalVy * restitution;
  projectile.energy = clamp(projectile.energy * energyLoss, 0, 1);
  projectile.bounces += 1;
  projectile.heading = bearing({x: 0, y: 0}, {x: projectile.vx, y: projectile.vy});
}

function canRicochet(projectile) {
  return projectile.energy >= MIN_RICOCHET_ENERGY
    && projectile.bounces < MAX_RICOCHETS
    && Math.hypot(projectile.vx, projectile.vy) >= 10;
}

export function surfaceAt(point) {
  return pointInsideRect(point) ? "ground" : "water";
}

export function distancePointToSegment(point, a, b) {
  const dx = (Number(b?.x) || 0) - (Number(a?.x) || 0);
  const dy = (Number(b?.y) || 0) - (Number(a?.y) || 0);
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-9) return Math.hypot((Number(point?.x) || 0) - (Number(a?.x) || 0), (Number(point?.y) || 0) - (Number(a?.y) || 0));
  const t = clamp((((Number(point?.x) || 0) - (Number(a?.x) || 0)) * dx
    + ((Number(point?.y) || 0) - (Number(a?.y) || 0)) * dy) / lengthSquared, 0, 1);
  return Math.hypot(
    (Number(point?.x) || 0) - ((Number(a?.x) || 0) + dx * t),
    (Number(point?.y) || 0) - ((Number(a?.y) || 0) + dy * t),
  );
}

export function stepMegaBombPhysics(projectile, rawDt) {
  const dt = clamp(rawDt, 0, 0.1);
  const previous = {x: projectile.x, y: projectile.y, z: projectile.z};
  projectile.age += dt;
  projectile.armed ||= projectile.age >= 0.22;
  const drag = Math.exp(-AIR_DRAG * dt);
  projectile.vx *= drag;
  projectile.vy *= drag;
  projectile.vz -= MEGA_BOMB_GRAVITY * dt;
  const next = {
    x: projectile.x + projectile.vx * dt,
    y: projectile.y + projectile.vy * dt,
    z: projectile.z + projectile.vz * dt,
  };
  projectile.distanceTravelled += Math.hypot(next.x - previous.x, next.y - previous.y);
  projectile.energy = clamp(projectile.energy * Math.exp(-0.026 * dt), 0, 1);

  const boundary = worldBoundaryHit(next);
  if (boundary) {
    projectile.x = boundary.x + boundary.nx * 0.08;
    projectile.y = boundary.y + boundary.ny * 0.08;
    projectile.z = Math.max(0.25, next.z);
    if (!canRicochet(projectile)) {
      return {previous, terminal: true, reason: "boundary-impact", surface: surfaceAt(projectile)};
    }
    reflectHorizontal(projectile, boundary, BOUNDARY_RESTITUTION, 0.58);
    projectile.vz = Math.max(projectile.vz * 0.58, 3.8);
    projectile.lastCollision = "boundary";
    return {previous, terminal: false, ricochet: true, reason: "boundary-ricochet", surface: "boundary", normal: boundary};
  }

  const wasLand = pointInsideRect(previous);
  const becomesLand = pointInsideRect(next);
  const shoreHit = wasLand !== becomesLand && Math.min(previous.z, next.z) <= MEGA_BOMB_SHORE_WALL_HEIGHT
    ? segmentBoundaryHit(previous, next)
    : null;
  if (shoreHit) {
    const keepPreviousSide = wasLand ? -1 : 1;
    projectile.x = shoreHit.x + shoreHit.nx * keepPreviousSide * 0.12;
    projectile.y = shoreHit.y + shoreHit.ny * keepPreviousSide * 0.12;
    projectile.z = Math.max(0.45, previous.z + (next.z - previous.z) * shoreHit.t);
    if (!canRicochet(projectile)) {
      return {previous, terminal: true, reason: "terrain-collision", surface: "shore"};
    }
    reflectHorizontal(projectile, shoreHit, SHORE_RESTITUTION, 0.55);
    projectile.vz = Math.max(projectile.vz * 0.35, 5.4);
    projectile.lastCollision = "shore";
    return {previous, terminal: false, ricochet: true, reason: "shore-ricochet", surface: "shore", normal: shoreHit};
  }

  projectile.x = next.x;
  projectile.y = next.y;
  projectile.z = next.z;
  projectile.heading = bearing({x: 0, y: 0}, {x: projectile.vx, y: projectile.vy});

  if (pointInsideRect(projectile) && projectile.z <= 0.3 && projectile.vz <= 0) {
    projectile.z = 0.3;
    return {previous, terminal: true, reason: "ground-impact", surface: "ground"};
  }
  if (!pointInsideRect(projectile) && projectile.z <= 0 && projectile.vz <= 0) {
    projectile.z = 0;
    return {previous, terminal: true, reason: "water-impact", surface: "water"};
  }
  if (projectile.age >= projectile.maxAge || projectile.energy <= 0.08) {
    return {previous, terminal: true, reason: "energy-expired", surface: surfaceAt(projectile)};
  }
  return {previous, terminal: false, ricochet: false, surface: surfaceAt(projectile)};
}
