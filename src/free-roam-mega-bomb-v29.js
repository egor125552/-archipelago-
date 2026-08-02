"use strict";

import * as base from "./free-roam-mega-bomb-v28.js";
import {
  MEGA_BOMB_LAND_RECT,
  bearing,
  clamp,
  distancePointToSegment,
  pointInsideRect,
  sourceVelocity,
  speed3,
  surfaceAt,
} from "./free-roam-mega-bomb-physics-v1.js";
import {listCombatTargets} from "../public/src/free-roam-targeting.js?v=35";
import {
  closestApproach,
  impactRadius,
  predictProjectile,
  shoreImpactMode,
  waterSkipEligible,
} from "./free-roam-mega-bomb-scenarios-v1.js";
import {activePursuers} from "../public/src/free-roam-pursuer-squad.js?v=33";
import {activeHostileGunners} from "../public/src/free-roam-hostile-gunners.js?v=32";
import {activeEnemyBoats} from "../public/src/free-roam-enemy-boats.js?v=3";
import {activeHostileActors} from "../public/src/free-roam-hostile-actors.js?v=2";

export * from "./free-roam-mega-bomb-v28.js";

const WATER_SKIP_MIN_SPEED = 34;
const WATER_SKIP_MAX_SLOPE = 0.29;
const AIR_COLLISION_RADIUS = 3.4;
const LOW_TARGET_HEIGHT = 5.2;

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const distance3 = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
  (Number(a?.z) || 0) - (Number(b?.z) || 0),
);

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function boatForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  return world.boats?.find(boat => boat?.id === player.activeBoat)
    || world.boats?.[player.activeBoat]
    || null;
}

function pointForPlayer(world, playerIndex) {
  return boatForPlayer(world, playerIndex) || world.players?.[playerIndex] || null;
}

function listenerVelocity(world, playerIndex) {
  const boat = boatForPlayer(world, playerIndex);
  return boat ? sourceVelocity(boat) : {vx: 0, vy: 0};
}

function wrap(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

function spatial(world, source) {
  const sourceSpeed = speed3(source);
  return (world.players || []).map((_, index) => {
    const listener = pointForPlayer(world, index);
    if (!listener || world.freeActivities?.presence?.[index] === false) {
      return {
        pan: 0, gain: 0, distance: 999, listenerX: null, listenerY: null,
        listenerHeading: 0, radialSpeed: 0, speed: sourceSpeed, elevation: 0,
        occluded: false, surface: surfaceAt(source),
      };
    }
    const horizontal = distance(listener, source);
    const metres = Math.hypot(horizontal, Math.max(0, Number(source.z) || 0));
    const relative = wrap(bearing(listener, source) - (Number(listener.heading) || 0));
    const motion = listenerVelocity(world, index);
    const dx = (Number(source.x) || 0) - (Number(listener.x) || 0);
    const dy = (Number(source.y) || 0) - (Number(listener.y) || 0);
    const length = Math.hypot(dx, dy) || 1;
    const radialSpeed = (((Number(source.vx) || 0) - motion.vx) * dx
      + ((Number(source.vy) || 0) - motion.vy) * dy) / length;
    return {
      pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
      gain: clamp(1 - metres / 320, 0.02, 1),
      distance: Math.round(metres * 10) / 10,
      listenerX: Number(listener.x) || 0,
      listenerY: Number(listener.y) || 0,
      listenerHeading: Number(listener.heading) || 0,
      radialSpeed: Math.round(radialSpeed * 10) / 10,
      speed: Math.round(sourceSpeed * 10) / 10,
      elevation: Math.atan2(Math.max(0, Number(source.z) || 0), Math.max(0.1, horizontal)) * 180 / Math.PI,
      occluded: base.megaBombPathBlocked(source, listener),
      surface: surfaceAt(source),
    };
  });
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotateVelocity(projectile, degrees) {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const vx = projectile.vx * cosine - projectile.vy * sine;
  const vy = projectile.vx * sine + projectile.vy * cosine;
  projectile.vx = vx;
  projectile.vy = vy;
  projectile.heading = bearing({x: 0, y: 0}, {x: vx, y: vy});
  projectile.targetX = projectile.x + vx / Math.max(1, Math.hypot(vx, vy)) * projectile.intendedDistance;
  projectile.targetY = projectile.y + vy / Math.max(1, Math.hypot(vx, vy)) * projectile.intendedDistance;
  projectile.throwVariationDeg = degrees;
}

function refreshLaunchEvent(world, projectile) {
  for (let index = (world.events || []).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launch" || event.projectileId !== projectile.id) continue;
    Object.assign(event, projectile, {
      projectileId: projectile.id,
      speed: speed3(projectile),
      surface: surfaceAt(projectile),
      spatial: spatial(world, projectile),
    });
    break;
  }
}

export function launchMegaBomb(world, playerIndex) {
  const known = new Set((world?.freeMegaBombs?.projectiles || []).map(item => item?.id));
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;
  const projectile = [...(world.freeMegaBombs?.projectiles || [])]
    .reverse().find(item => item?.owner === playerIndex && !known.has(item?.id));
  if (!projectile) return true;
  // A free throw is not a laser. The variation is deterministic on the server,
  // small enough to learn, and reduced while a fast boat supplies a stable vector.
  if (!projectile.targetId) {
    const unit = (hashNumber(projectile.id) % 2001) / 1000 - 1;
    const inherited = clamp(Number(projectile.sourceSpeed) || 0, 0, 30);
    const maximum = 7.2 - inherited * 0.12;
    rotateVelocity(projectile, Math.round(unit * maximum * 10) / 10);
  }
  refreshLaunchEvent(world, projectile);
  return true;
}

function prepareShoreAngles(state, seconds) {
  for (const projectile of state.projectiles || []) {
    const mode = shoreImpactMode(projectile, seconds);
    if (mode === "impact") projectile.energy = Math.min(projectile.energy, 0.18);
    else if (mode === "ricochet" && projectile.energy > 0.32) projectile.energy = Math.min(1, projectile.energy * 1.04);
  }
}

function prepareWaterSkips(world, state, seconds) {
  for (const projectile of state.projectiles || []) {
    if (!waterSkipEligible(projectile, seconds)) continue;
    const horizontal = Math.hypot(projectile.vx, projectile.vy);
    projectile.z = 0.28;
    projectile.vz = clamp(4.4 + horizontal * 0.105, 5.2, 8.8);
    projectile.vx *= 0.78;
    projectile.vy *= 0.78;
    projectile.energy = clamp(projectile.energy * 0.67, 0, 1);
    projectile.bounces += 1;
    projectile.lastCollision = "water";
    projectile.waterSkipCooldownUntil = projectile.age + 0.34;
    projectile.heading = bearing({x: 0, y: 0}, {x: projectile.vx, y: projectile.vy});
    emit(world, "mega-bomb-ricochet", "", [0, 1], {
      ...projectile,
      projectileId: projectile.id,
      reason: "water-skip",
      surface: "water",
      speed: speed3(projectile),
      spatial: spatial(world, projectile),
    });
  }
}

function prepareAirCollisions(world, state, seconds) {
  const removed = new Set();
  const forced = new Map();
  for (let left = 0; left < state.projectiles.length; left += 1) {
    const a = state.projectiles[left];
    if (removed.has(a.id) || !a.armed) continue;
    for (let right = left + 1; right < state.projectiles.length; right += 1) {
      const b = state.projectiles[right];
      if (removed.has(b.id) || !b.armed || a.owner === b.owner) continue;
      const approach = closestApproach(a, b, seconds);
      if (approach.distance > AIR_COLLISION_RADIUS) continue;
      const survivor = a.energy >= b.energy ? a : b;
      const absorbed = survivor === a ? b : a;
      const time = approach.time;
      survivor.x = (a.x + a.vx * time + b.x + b.vx * time) / 2;
      survivor.y = (a.y + a.vy * time + b.y + b.vy * time) / 2;
      survivor.z = Math.max(0.6, (a.z + a.vz * time + b.z + b.vz * time) / 2);
      survivor.vx = (a.vx + b.vx) * 0.12;
      survivor.vy = (a.vy + b.vy) * 0.12;
      survivor.vz = (a.vz + b.vz) * 0.08;
      survivor.energy = 0.05;
      survivor.interceptedWith = absorbed.id;
      removed.add(absorbed.id);
      forced.set(survivor.id, {absorbedId: absorbed.id, owners: [a.owner, b.owner]});
      emit(world, "mega-bomb-intercept", "Две мега-бомбы столкнулись в воздух�.", [0, 1], {
        sourcePlayer: survivor.owner,
        projectileId: survivor.id,
        otherProjectileId: absorbed.id,
        x: survivor.x, y: survivor.y, z: survivor.z,
        spatial: spatial(world, survivor),
      });
      break;
    }
  }
  if (removed.size) state.projectiles = state.projectiles.filter(item => !removed.has(item.id));
  return forced;
}

function impactTargets(world, projectile) {
  const result = [];
  const presence = world.freeActivities?.presence || [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (presence[index] === false || !world.players[index]?.combat?.alive) continue;
    const point = pointForPlayer(world, index);
    if (point) result.push({kind: "player", playerIndex: index, point});
  }
  for (const boat of world.boats || []) if (boat && !boat.sunk) result.push({kind: "boat", point: boat});
  for (const target of listCombatTargets(world, projectile.owner, Infinity)) {
    if (!["player", "boat"].includes(target.kind)) result.push(target);
  }
  return result;
}

function prepareLargeTargetContacts(world, state, seconds) {
  for (const projectile of state.projectiles || []) {
    if (!projectile.armed || projectile.z > LOW_TARGET_HEIGHT) continue;
    const next = predictProjectile(projectile, seconds);
    for (const target of impactTargets(world, projectile)) {
      if (!target?.point || target.point.destroyed || target.point.sunk) continue;
      const radius = impactRadius(target);
      const metres = distancePointToSegment(target.point, projectile, next);
      if (metres > radius || metres <= 3.05) continue;
      if (base.megaBombPathBlocked(projectile, target.point)) continue;
      projectile.x = Number(target.point.x) || projectile.x;
      projectile.y = Number(target.point.y) || projectile.y;
      projectile.z = Math.min(projectile.z, 3.8);
      projectile.vx *= 0.04;
      projectile.vy *= 0.04;
      projectile.vz = Math.min(projectile.vz, -1);
      projectile.forcedTargetKind = target.kind;
      break;
    }
  }
}

function turnAway(entity, blast, speedScale = 1) {
  if (!entity || entity.destroyed || entity.sunk) return;
  entity.heading = bearing(blast, entity);
  if (Number.isFinite(Number(entity.speed))) entity.speed = clamp(
    (Number(entity.speed) || 0) * 0.55 + 5.5 * speedScale,
   -35, 35,
  );
}

function reactEnemiesToBlast(world, event) {
  const blast = {x: event.x, y: event.y};
  let reactions = 0;
  for (const actor of activeHostileActors(world)) {
    const metres = distance(blast, actor);
    if (metres > 58) continue;
    actor.aimRemaining = 0;
    actor.burstRemaining = 0;
    actor.windupRemaining = 0;
    actor.fireCooldown = Math.max(Number(actor.fireCooldown) || 0, clamp(2.2 - metres / 45, 0.65, 2.2));
    actor.heading = bearing(blast, actor);
    reactions += 1;
  }
  for (const gunner of activeHostileGunners(world)) {
    const metres = distance(blast, gunner);
    if (metres > 58) continue;
    gunner.aimRemaining = 0;
    gunner.fireCooldown = Math.max(Number(gunner.fireCooldown) || 0, clamp(2 - metres / 48, 0.55, 2));
    gunner.heading = bearing(blast, gunner);
    reactions += 1;
  }
  for (const boat of [...activePursuers8world), ...activeEnemyBoats(world)]) {
    const metres = distance(blast, boat);
    if (metres > 70) continue;
    turnAway(boat, blast, 1);
    boat.fireCooldown = Math.max(Number(boat.fireCooldown) || 0, clamp(2.3 - metres / 55, 0.6, 2.3));
    boat.ramCooldown = Math.max(Number(boat.ramCooldown) || 0, 1.4);
    reactions += 1;
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && distance(blast, heavy) <= 78) {
    heavy.aimRemaining = 0;
    heavy.burstRemaining = 0;
    heavy.fireCooldown = Math.max(Number(heavy.fireCooldown) || 0, 2.4);
    turnAway(heavy, blast, 0.55);
    reactions += 1;
  }
  if (reactions) emit(world, "mega-bomb-enemy-shock", "", [0, 1], {
    sourcePlayer: event.sourcePlayer,
    projectileId: event.projectileId,
    reactionCount: reactions,
    x: event.x, y: event.y,
  });
}

export function stepMegaBombs(world, dt) {
  const state = base.ensureMegaBombState(world);
  const seconds = clamp(dt, 0, 0.1);
  prepareShoreAngles(state, seconds);
  prepareWaterSkips(world, state, seconds);
  prepareLargeTargetContacts(world, state, seconds);
  const forcedIntercepts = prepareAirCollisions(world, state, seconds);
  const eventStart = (world.events || []).length;
  base.stepMegaBombs(world, seconds);
  const fresh = (world.events || []).slice(eventStart);
  for (const event of fresh) {
    if (event.type !== "mega-bomb-explosion") continue;
    const intercept = forcedIntercepts.get(event.projectileId);
    if (intercept) {
      event.reason = "air-intercept";
      event.surface = "air";
      event.otherProjectileId = intercept.absorbedId;
      event.interceptOwners = intercept.owners;
    }
    reactEnemiesToBlast(world, event);
  }
}

export const ensureMegaBombState = base.ensureMegaBombState;
export const reportMegaBombStatus = base.reportMegaBombStatus;
export const megaBombStatus = base.megaBombStatus;
