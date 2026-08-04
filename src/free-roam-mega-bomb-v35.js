"use strict";

import * as base from "./free-roam-mega-bomb-v34.js";
import {resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=36";
import {MEGA_BOMB_WORLD_BOUNDS, headingVector} from "./free-roam-mega-bomb-physics-v1.js";

export * from "./free-roam-mega-bomb-v34.js";

const MIN_SAFE_UNTARGETED_CLEARANCE = 24;

const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
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

export function forwardBoundaryClearanceV35(point, heading, bounds = MEGA_BOMB_WORLD_BOUNDS) {
  if (!point) return Infinity;
  const direction = headingVector(heading);
  const distances = [];
  if (direction.x > 1e-9) distances.push((bounds.maxX - Number(point.x)) / direction.x);
  if (direction.x < -1e-9) distances.push((bounds.minX - Number(point.x)) / direction.x);
  if (direction.y > 1e-9) distances.push((bounds.maxY - Number(point.y)) / direction.y);
  if (direction.y < -1e-9) distances.push((bounds.minY - Number(point.y)) / direction.y);
  const positive = distances.filter(value => Number.isFinite(value) && value >= 0);
  return positive.length ? Math.min(...positive) : Infinity;
}

export function untargetedBoundaryRiskV35(world, playerIndex) {
  const player = world.players?.[playerIndex];
  const origin = pointForPlayer(world, playerIndex);
  if (!player || !origin) return null;
  const targetId = player.combat?.lockedTargetId;
  const target = resolveCombatTarget(world, playerIndex, targetId, base.MEGA_BOMB_LONG_RANGE);
  if (target?.point) return null;
  const clearance = forwardBoundaryClearanceV35(origin, origin.heading ?? player.heading);
  return clearance < MIN_SAFE_UNTARGETED_CLEARANCE ? clearance : null;
}

export function launchMegaBomb(world, playerIndex) {
  const clearance = untargetedBoundaryRiskV35(world, playerIndex);
  if (clearance !== null) {
    const remaining = Math.max(0, Math.floor(Number(
      world.players?.[playerIndex]?.combat?.megaBombStock
      ?? world.players?.[playerIndex]?.combat?.megaBombAmmo,
    ) || 0));
    emit(
      world,
      "mega-bomb-denied",
      "Перед тобой слишком близко граница мира. Развернись или выбери цель: иначе мега-бомба сразу отрикошетит обратно.",
      [playerIndex],
      {
        sourcePlayer: playerIndex,
        remaining,
        clearance: Math.round(clearance * 10) / 10,
        boundarySafetyV35: true,
      },
    );
    return false;
  }
  return base.launchMegaBomb(world, playerIndex);
}

export {MIN_SAFE_UNTARGETED_CLEARANCE};
