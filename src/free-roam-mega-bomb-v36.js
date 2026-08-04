"use strict";

import * as base from "./free-roam-mega-bomb-v35.js";
import {resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=36";
import {MEGA_BOMB_WORLD_BOUNDS, headingVector} from "./free-roam-mega-bomb-physics-v1.js";

export * from "./free-roam-mega-bomb-v35.js";

const MAX_LEAD_DISTANCE = 52;
const MAX_LEAD_TIME = 4.8;
const HEAVY_TARGET_IDS = new Set(["heavy-pursuer", "heavy-turret", "heavy-engine"]);
const MOVING_REPAIR_PHASES = new Set(["breach-escaping-v166", "breach-returning-v166"]);
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
  return heavy?.destination
    || world?.freeCombatAiV172?.stableRepairDestination
    || heavy?.v168SafeDestination
    || heavy?.v167ReachableDestination
    || null;
}

export function predictHeavyPositionV36(world, boat, seconds, bounds = MEGA_BOMB_WORLD_BOUNDS) {
  if (!boat) return null;
  const heavy = world?.freeCombatAiV164?.heavy;
  const phase = String(heavy?.phase || "combat");
  const destination = repairDestination(world, heavy);
  const point = {
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
    heading: Number(boat.heading) || 0,
    speed: Math.max(0, Number(boat.speed) || 0),
  };

  // V36 only predicts movement that belongs to the unified V166+ repair
  // lifecycle. Ordinary combat remains aimed at the current physical target,
  // and deleted V164 phases are deliberately not supported here.
  if (phase === "breach-repairing-v166") return currentPoint(point);
  if (phase !== "breach-stopping-v166" && (!MOVING_REPAIR_PHASES.has(phase) || !destination)) {
    return currentPoint(point);
  }

  const total = clamp(seconds, 0, MAX_LEAD_TIME);
  const stepSize = 0.08;
  let elapsed = 0;
  while (elapsed < total - 1e-9) {
    const dt = Math.min(stepSize, total - elapsed);
    if (phase === "breach-stopping-v166") {
      point.speed += clamp(0 - point.speed, -5.8 * dt, 5.8 * dt);
    } else {
      const desiredHeading = bearing(point, destination);
      const desiredSpeed = phase === "breach-returning-v166" ? 12.1 : 13.4;
      point.heading = wrapDeg(point.heading + clamp(wrapDeg(desiredHeading - point.heading), -38 * dt, 38 * dt));
      point.speed += clamp(desiredSpeed - point.speed, -7 * dt, 5.4 * dt);
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
  let predicted = predictHeavyPositionV36(world, target, flightTime, bounds)
    || currentPoint(target);

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
  return {
    ...predicted,
    leadTime: flightTime,
    leadDistance: distance(predicted, target),
    targetSpeed: Math.max(0, Number(target.speed) || 0),
  };
}

function refreshLaunchEvent(world, projectile, lead) {
  for (let index = values(world.events).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launch" || event.projectileId !== projectile.id) continue;
    Object.assign(event, {
      x: projectile.x,
      y: projectile.y,
      z: projectile.z,
      vx: projectile.vx,
      vy: projectile.vy,
      vz: projectile.vz,
      heading: projectile.heading,
      targetX: projectile.targetX,
      targetY: projectile.targetY,
      intendedDistance: projectile.intendedDistance,
      intendedFlightTime: projectile.intendedFlightTime,
      maxAge: projectile.maxAge,
      movingTargetLeadV36: true,
      leadDistance: lead.leadDistance,
      leadTime: lead.leadTime,
      targetSpeed: lead.targetSpeed,
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

  const phase = String(world?.freeCombatAiV164?.heavy?.phase || "combat");
  if (phase !== "breach-stopping-v166" && phase !== "breach-repairing-v166" && !MOVING_REPAIR_PHASES.has(phase)) {
    return false;
  }

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
  projectile.targetX = lead.x;
  projectile.targetY = lead.y;
  projectile.targetId = targetId;
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
  const projectile = values(world?.freeMegaBombs?.projectiles)
    .slice()
    .reverse()
    .find(item => item?.owner === playerIndex && !known.has(String(item?.id || "")));
  applyMovingTargetLeadV36(world, playerIndex, projectile);
  return true;
}

export {MAX_LEAD_DISTANCE, MAX_LEAD_TIME, MOVING_REPAIR_PHASES};
