"use strict";

import * as base from "./free-roam-mega-bomb-v33.js";
import {resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=36";

export * from "./free-roam-mega-bomb-v33.js";

export const MEGA_BOMB_LONG_RANGE = 320;
const GRAVITY = 16.5;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function pointForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return world.boats?.find(boat => boat?.id === player.activeBoat)
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function refreshLaunchEvent(world, projectile) {
  for (let index = (world.events || []).length - 1; index >= 0; index -= 1) {
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
      targetId: projectile.targetId,
      intendedDistance: projectile.intendedDistance,
      intendedFlightTime: projectile.intendedFlightTime,
      maxAge: projectile.maxAge,
      longRangeV34: true,
      speed: Math.hypot(projectile.vx, projectile.vy, projectile.vz),
    });
    return;
  }
}

export function longRangeFlightSolution(intendedDistance, horizontalSpeed) {
  const distanceValue = clamp(intendedDistance, 18, MEGA_BOMB_LONG_RANGE);
  const speedValue = clamp(horizontalSpeed, 44, 68);
  const flightTime = clamp(distanceValue / speedValue, 1.05, 7.2);
  return {
    intendedDistance: distanceValue,
    horizontalSpeed: speedValue,
    flightTime,
    vz: clamp(GRAVITY * flightTime * 0.5 + 0.35 / flightTime, 9.5, 51),
    maxAge: clamp(flightTime + 3.2, 4.2, 11.5),
  };
}

function retargetLongShot(world, playerIndex, projectile) {
  const origin = pointForPlayer(world, playerIndex);
  const lockedId = world.players?.[playerIndex]?.combat?.lockedTargetId;
  const target = resolveCombatTarget(world, playerIndex, lockedId, MEGA_BOMB_LONG_RANGE);
  if (!origin || !target?.point || !projectile) return false;

  const metres = distance(origin, target.point);
  if (metres <= 205) return false;
  const dx = (Number(target.point.x) || 0) - (Number(projectile.x) || 0);
  const dy = (Number(target.point.y) || 0) - (Number(projectile.y) || 0);
  const length = Math.hypot(dx, dy) || 1;
  const solution = longRangeFlightSolution(
    Math.hypot(dx, dy),
    Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0),
  );

  projectile.vx = dx / length * solution.horizontalSpeed;
  projectile.vy = dy / length * solution.horizontalSpeed;
  projectile.vz = solution.vz;
  projectile.heading = Math.atan2(projectile.vx, -projectile.vy) * 180 / Math.PI;
  projectile.targetX = Number(target.point.x) || projectile.x;
  projectile.targetY = Number(target.point.y) || projectile.y;
  projectile.targetId = target.id;
  projectile.intendedDistance = solution.intendedDistance;
  projectile.intendedFlightTime = solution.flightTime;
  projectile.maxAge = solution.maxAge;
  projectile.energy = Math.max(0.9, Number(projectile.energy) || 0);
  projectile.longRangeV34 = true;
  refreshLaunchEvent(world, projectile);
  return true;
}

export function launchMegaBomb(world, playerIndex) {
  const known = new Set((world?.freeMegaBombs?.projectiles || []).map(projectile => String(projectile?.id || "")));
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;
  const projectile = [...(world.freeMegaBombs?.projectiles || [])]
    .reverse()
    .find(item => item?.owner === playerIndex && !known.has(String(item?.id || "")));
  retargetLongShot(world, playerIndex, projectile);
  return true;
}
