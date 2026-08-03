"use strict";

import {applyCombatAiModelV172, MEGA_BOMB_RANGE} from "./free-roam-combat-ai-model-v172.js?v=1";
import {resolveCombatTarget} from "./free-roam-targeting.js?v=35";

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function pointForPlayer(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function requestedTargetId(world, index) {
  const combat = world.players?.[index]?.combat;
  const input = world.freeActivities?.inputs?.[index]
    || world.operationInputs?.[index]
    || world.inputs?.[index]
    || {};
  return input.targetId || combat?.lastTargetRequestId || null;
}

export function clearFarTargetReplacementV173(world) {
  for (let index = 0; index < values(world.players).length; index += 1) {
    const combat = world.players?.[index]?.combat;
    const targetId = requestedTargetId(world, index);
    if (!combat?.alive || !targetId) continue;
    const target = resolveCombatTarget(world, index, targetId, Infinity);
    if (!target?.point) continue;
    const metres = distance(pointForPlayer(world, index), target.point);
    if (metres > MEGA_BOMB_RANGE) combat.lockedTargetId = null;
  }
}

export function applyCombatAiModelV173(world, dt, helpers = {}) {
  const result = applyCombatAiModelV172(world, dt, helpers);
  if ((Number(dt) || 0) > 0) clearFarTargetReplacementV173(world);
  return result;
}
