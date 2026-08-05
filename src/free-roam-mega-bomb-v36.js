"use strict";

import * as base from "./free-roam-mega-bomb-v35.js";
import {resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=37";
import {MEGA_BOMB_WORLD_BOUNDS, createMegaBombProjectile, headingVector} from "./free-roam-mega-bomb-physics-v1.js";
import {damageEliteBoatBoss} from "../public/src/free-roam-elite-boat.js?v=1";

export * from "./free-roam-mega-bomb-v35.js";

const MAX_LEAD_DISTANCE = 52;
const MAX_LEAD_TIME = 4.8;
const HEAVY_TARGET_IDS = new Set(["heavy-pursuer", "heavy-turret", "heavy-engine"]);
const MOVING_REPAIR_PHASES = new Set(["escape", "returning"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}
function pointForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}
function currentPoint(boat) {
  return {x: Number(boat?.x) || 0, y: Number(boat?.y) || 0};
}
function repairDestination(world, heavy) {
  return heavy?.destination || world?.freeHeavyAiControllerV1?.heavy?.destination || null;
}
function repairMovementActive(heavy, phase) {
  if (phase === "returning") return true;
  if (phase !== "escape") return false;
  return heavy?.repairSystem === "turret" && heavy?.escapeReason === "repair";
}

export function predictHeavyPositionV36(world, boat, seconds, bounds = MEGA_BOMB_WORLD_BOUNDS) {
  if (!boat) return null;
  const heavy = world?.freeHeavyAiControllerV1?.heavy || world?.freeCombatAiV164?.heavy;
  const phase = String(heavy?.phase || "combat");
  const destination = repairDestination(world, heavy);
  const point = {
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
    heading: Number(boat.heading) || 0,
    speed: Math.max(0, Number(boat.speed) || 0),
  };

  // Упреждение разрешено только для единого ремонтного маршрута.
  // Обычный бой и тактический отход не превращают бомбу в самонаводящуюся.
  if (phase === "repairing") return currentPoint(point);
  if (phase !== "stopping" && (!repairMovementActive(heavy, phase) || !destination)) {
    return currentPoint(point);
  }

  const total = clamp(seconds, 0, MAX_LEAD_TIME);
  const stepSize = 0.08;
  let elapsed = 0;
  while (elapsed < total - 1e-9) {
    const dt = Math.min(stepSize, total - elapsed);
    if (phase === "stopping") {
      point.speed += clamp(0 - point.speed, -5.8 * dt, 5.8 * dt);
    } else {
      const desiredHeading = bearing(point, destination);
      const desiredSpeed = phase === "returning" ? 12.1 : 14.6;
      point.heading = wrapDeg(point.heading + clamp(wrapDeg(desiredHeading - point.heading), -76 * dt, 76 * dt));
      point.speed += clamp(desiredSpeed - point.speed, -12 * dt, 14 * dt);
      if (distance(point, destination) <= Math.max(5, point.speed * dt)) {
        point.x = clamp(destination.x, bounds.minX, bounds.maxX);
        point.y = clamp(destination.y, bounds.minY, bounds.maxY);
        point.speed = 0;
        break;
      }
    }
    const direction = headingVector(point.heading);
    point.x = clamp(point.x + direction.x * point.speed * dt, bounds.minX, bounds.maxX);
    point.y = clamp(point.y + direction.y * point.speed * dt, bounds.minY, bounds.maxY);
    elapsed += dt;
  }
  return currentPoint(point);
}

export function leadTargetPointV36(world, origin, target, projectileSpeed, bounds = MEGA_BOMB_WORLD_BOUNDS) {
  if (!origin || !target) return null;
  const horizontalSpeed = clamp(projectileSpeed, 44, 68);
  let flightTime = clamp(distance(origin, target) / horizontalSpeed, 1.05, MAX_LEAD_TIME);
  let predicted = predictHeavyPositionV36(world, target, flightTime, bounds) || currentPoint(target);
  const dx = predicted.x - Number(target.x || 0);
  const dy = predicted.y - Number(target.y || 0);
  const rawLead = Math.hypot(dx, dy);
  if (rawLead > MAX_LEAD_DISTANCE) {
    const scale = MAX_LEAD_DISTANCE / rawLead;
    predicted = {
      x: clamp(Number(target.x || 0) + dx * scale, bounds.minX, bounds.maxX),
      y: clamp(Number(target.y || 0) + dy * scale, bounds.minY, bounds.maxY),
    };
  }
  flightTime = clamp(distance(origin, predicted) / horizontalSpeed, 1.05, MAX_LEAD_TIME);
  return {...predicted, leadTime: flightTime, leadDistance: distance(predicted, target), targetSpeed: Math.max(0, Number(target.speed) || 0)};
}

function refreshLaunchEvent(world, projectile, lead) {
  for (let index = values(world.events).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launch" || event.projectileId !== projectile.id) continue;
    Object.assign(event, {
      x: projectile.x, y: projectile.y, z: projectile.z,
      vx: projectile.vx, vy: projectile.vy, vz: projectile.vz,
      heading: projectile.heading, targetX: projectile.targetX, targetY: projectile.targetY,
      intendedDistance: projectile.intendedDistance, intendedFlightTime: projectile.intendedFlightTime,
      maxAge: projectile.maxAge, movingTargetLeadV36: true,
      leadDistance: lead.leadDistance, leadTime: lead.leadTime, targetSpeed: lead.targetSpeed,
      speed: Math.hypot(projectile.vx, projectile.vy, projectile.vz),
    });
    return;
  }
}

export function applyMovingTargetLeadV36(world, playerIndex, projectile) {
  const origin = pointForPlayer(world, playerIndex);
  const lockedId = world.players?.[playerIndex]?.combat?.lockedTargetId;
  const target = resolveCombatTarget(world, playerIndex, lockedId, base.MEGA_BOMB_LONG_RANGE);
  const targetId = String(target?.id || lockedId || "");
  if (!origin || !projectile || !target?.point || !HEAVY_TARGET_IDS.has(targetId)) return false;

  const heavy = world?.freeHeavyAiControllerV1?.heavy || world?.freeCombatAiV164?.heavy;
  const phase = String(heavy?.phase || "combat");
  if (phase !== "stopping" && phase !== "repairing" && !repairMovementActive(heavy, phase)) return false;

  const boat = world.freeHeavyPursuer?.boat;
  if (!boat) return false;
  const movingPoint = {...boat, id: "heavy-pursuer", role: "heavy"};
  const horizontalSpeed = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
  const lead = leadTargetPointV36(world, projectile, movingPoint, horizontalSpeed);
  if (!lead || lead.leadDistance < 0.5) return false;

  const dx = lead.x - Number(projectile.x || 0);
  const dy = lead.y - Number(projectile.y || 0);
  const length = Math.hypot(dx, dy) || 1;
  const solution = base.longRangeFlightSolution(length, horizontalSpeed);
  projectile.vx = dx / length * solution.horizontalSpeed;
  projectile.vy = dy / length * solution.horizontalSpeed;
  projectile.vz = solution.vz;
  projectile.heading = Math.atan2(projectile.vx, -projectile.vy) * 180 / Math.PI;
  projectile.targetX = lead.x; projectile.targetY = lead.y; projectile.targetId = targetId;
  projectile.intendedDistance = solution.intendedDistance;
  projectile.intendedFlightTime = solution.flightTime;
  projectile.maxAge = solution.maxAge;
  projectile.movingTargetLeadV36 = true;
  projectile.leadDistance = lead.leadDistance;
  projectile.targetSpeedAtLaunch = lead.targetSpeed;
  refreshLaunchEvent(world, projectile, lead);
  return true;
}

export function launchMegaBomb(world, playerIndex) {
  const known = new Set(values(world?.freeMegaBombs?.projectiles).map(projectile => String(projectile?.id || "")));
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;
  const projectile = values(world.freeMegaBombs?.projectiles).slice().reverse()
    .find(item => item?.owner === playerIndex && !known.has(String(item?.id || "")));
  applyMovingTargetLeadV36(world, playerIndex, projectile);
  return true;
}

export {MAX_LEAD_DISTANCE, MAX_LEAD_TIME, MOVING_REPAIR_PHASES};


function eliteSource(world, request) {
  if (request?.sourceType === "elite-commander") {
    return values(world?.freeHostileActors?.actors).find(actor => actor?.id === request.sourceId && actor.active && !actor.destroyed) || null;
  }
  const boat = world?.freeEliteBoatBoss?.boat;
  return boat?.alive && boat.id === request?.sourceId ? boat : null;
}

function emitHostileLaunch(world, projectile, request) {
  world.events ||= [];
  world.events.push({
    type: "mega-bomb-launch",
    text: "",
    targets: [0, 1],
    at: world.time,
    operationEvent: true,
    sourcePlayer: -1,
    hostile: true,
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    projectileId: projectile.id,
    x: projectile.x, y: projectile.y, z: projectile.z,
    vx: projectile.vx, vy: projectile.vy, vz: projectile.vz,
    heading: projectile.heading,
    targetX: projectile.targetX, targetY: projectile.targetY,
    intendedDistance: projectile.intendedDistance,
    intendedFlightTime: projectile.intendedFlightTime,
    maxAge: projectile.maxAge,
    speed: Math.hypot(projectile.vx, projectile.vy, projectile.vz),
  });
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function launchPendingEliteBossBombs(world) {
  const boss = world?.freeEliteBoatBoss;
  if (!boss || !Array.isArray(boss.bombRequests) || !boss.bombRequests.length) return 0;
  const state = base.ensureMegaBombState(world);
  let launched = 0;
  const pending = boss.bombRequests.splice(0, boss.bombRequests.length);
  for (const request of pending) {
    const source = eliteSource(world, request);
    if (!source) continue;
    const target = {
      x: clamp(request.targetX, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX),
      y: clamp(request.targetY, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY),
    };
    const heading = bearing(source, target);
    const direction = headingVector(heading);
    const start = {
      x: clamp(Number(source.x) + direction.x * 3.2, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX),
      y: clamp(Number(source.y) + direction.y * 3.2, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY),
      z: request.sourceType === "elite-commander" ? 1.9 : 2.55,
    };
    const inherited = request.sourceType === "elite-boat"
      ? {vx: direction.x * (Number(source.speed) || 0), vy: direction.y * (Number(source.speed) || 0)}
      : {vx: 0, vy: 0};
    const intendedDistance = clamp(distance(start, target), 22, 205);
    const projectile = createMegaBombProjectile({
      id: `hostile-mega-bomb-${boss.encounterId}-${state.nextId++}`,
      owner: -1,
      start,
      heading,
      intendedDistance,
      inheritedVelocity: inherited,
    });
    Object.assign(projectile, {
      targetX: target.x,
      targetY: target.y,
      targetId: null,
      sourceBoatId: request.sourceType === "elite-boat" ? source.id : null,
      sourceActorId: request.sourceType === "elite-commander" ? source.id : null,
      hostile: true,
      eliteBossEncounterId: boss.encounterId,
    });
    state.projectiles.push(projectile);
    emitHostileLaunch(world, projectile, request);
    launched += 1;
  }
  return launched;
}

function applyEliteExplosionDamage(world, event, targetId) {
  if (Number(event?.sourcePlayer) < 0) return false;
  const boss = world?.freeEliteBoatBoss;
  const boat = boss?.boat;
  if (!boss?.active || !boat?.alive) return false;
  const metres = distance(event, boat);
  if (metres > 38) return false;
  const baseDamage = clamp(230 * (1 - metres / 46), 18, 230);
  const exact = String(targetId || "");
  if (exact === "elite-turret-port") {
    damageEliteBoatBoss(world, "turret-port", baseDamage * 1.35, event.sourcePlayer, {weapon: "mega-bomb"});
    damageEliteBoatBoss(world, "armor", baseDamage * 0.22, event.sourcePlayer, {weapon: "mega-bomb"});
  } else if (exact === "elite-turret-starboard") {
    damageEliteBoatBoss(world, "turret-starboard", baseDamage * 1.35, event.sourcePlayer, {weapon: "mega-bomb"});
    damageEliteBoatBoss(world, "armor", baseDamage * 0.22, event.sourcePlayer, {weapon: "mega-bomb"});
  } else {
    damageEliteBoatBoss(world, exact.startsWith("elite-armor-") ? `armor-${exact.slice("elite-armor-".length)}` : "hull", baseDamage, event.sourcePlayer, {weapon: "mega-bomb"});
    for (const turret of boat.turrets || []) {
      if (!turret.destroyed) damageEliteBoatBoss(world, `turret-${turret.side}`, baseDamage * 0.16, event.sourcePlayer, {weapon: "mega-bomb"});
    }
  }
  event.eliteBossDamage = Math.round(baseDamage);
  event.eliteBossEncounterId = boss.encounterId;
  return true;
}

export function stepMegaBombs(world, dt) {
  const targetByProjectile = new Map(values(world?.freeMegaBombs?.projectiles).map(projectile => [String(projectile?.id || ""), String(projectile?.targetId || "")]));
  const eventStart = values(world?.events).length;
  base.stepMegaBombs(world, dt);
  for (const event of values(world?.events).slice(eventStart)) {
    if (event?.type !== "mega-bomb-explosion") continue;
    applyEliteExplosionDamage(world, event, targetByProjectile.get(String(event.projectileId || "")));
  }
}
