"use strict";

import {applyCombatAiModelV171, achievableTurretRepairClearanceV171} from "./free-roam-combat-ai-model-v171.js?v=1";
import {resolveCombatTarget} from "./free-roam-targeting.js?v=35";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=33";

const MEGA_BOMB_RANGE = 320;
const TARGET_MENU_RANGE = 420;
const CUSTOM_REPAIR_PHASES = new Set([
  "breach-escaping-v166",
  "breach-stopping-v166",
  "breach-repairing-v166",
  "breach-returning-v166",
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiV172 ||= {
    frame: null,
    repairEncounterId: null,
    stableRepairDestination: null,
    targetLocks: {},
    lastOutOfRangeFireAt: {},
  };
  const state = world.freeCombatAiV172;
  state.targetLocks ||= {};
  state.lastOutOfRangeFireAt ||= {};
  return state;
}

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

function livingPoints(world) {
  return values(world.players)
    .map((player, index) => ({player, index, point: pointForPlayer(world, index)}))
    .filter(({player, index, point}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && point);
}

function nearestPlayerDistance(world, point) {
  const living = livingPoints(world);
  return living.length ? Math.min(...living.map(item => distance(point, item.point))) : Infinity;
}

function repairCandidates() {
  const points = [];
  for (const x of [16, 42, 88, 150, 210, 272, 334, 380, 404]) {
    for (const y of [86, 108, 150, 200, 250, 292, 308]) points.push({x, y});
  }
  return points;
}

function safestStableRepairDestination(world, boat, clearance, serial = 0) {
  const living = livingPoints(world);
  return repairCandidates()
    .map(point => {
      const nearest = living.length ? Math.min(...living.map(item => distance(point, item.point))) : 999;
      const travel = distance(point, boat);
      const variation = ((point.x * 37 + point.y * 19 + serial * 29) % 23) * 0.001;
      return {point, nearest, travel, score: nearest * 5 + Math.min(150, travel) + variation};
    })
    .filter(item => item.travel >= 18 && item.nearest >= clearance)
    .sort((left, right) => right.score - left.score || right.travel - left.travel)[0]?.point
    || repairCandidates()
      .map(point => ({point, nearest: nearestPlayerDistance(world, point), travel: distance(point, boat)}))
      .filter(item => item.travel >= 18)
      .sort((left, right) => right.nearest - left.nearest || right.travel - left.travel)[0]?.point
    || {x: clamp(boat.x, 16, 404), y: clamp(boat.y, 86, 308)};
}

function incomingBombThreat(world, boat) {
  return values(world.freeMegaBombs?.projectiles).some(projectile => {
    if (!projectile || Number(projectile.energy) <= 0) return false;
    const ttl = Number(projectile.ttl);
    if (Number.isFinite(ttl) && ttl <= 0) return false;
    const age = Math.max(0, Number(projectile.age) || 0);
    const maxAge = Number(projectile.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0 && age >= maxAge) return false;
    if (["heavy-pursuer", "heavy-turret", "heavy-engine"].includes(projectile.targetId)) return true;
    const target = {x: projectile.targetX ?? projectile.x, y: projectile.targetY ?? projectile.y};
    return distance(target, boat) <= 105 || distance(projectile, boat) <= 145;
  });
}

function removeEvents(world, eventStart, predicate) {
  const start = Math.max(0, Number(eventStart) || 0);
  const prefix = values(world.events).slice(0, start);
  const filtered = values(world.events).slice(start).filter(event => !predicate(event));
  world.events = [...prefix, ...filtered];
}

function turretRecoveryApplicable(world) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  return Boolean(
    heavy
    && boat
    && boat.active
    && !boat.destroyed
    && Number(boat.hull) > 0
    && heavy.repairSystem === "turret"
    && Number(boat.turretHealth) <= 0
    && Number(boat.engineHealth) > 0
    && CUSTOM_REPAIR_PHASES.has(heavy.phase)
  );
}

export function stabilizeTurretRecoveryV172(world, state, eventStart = 0) {
  if (!turretRecoveryApplicable(world)) {
    state.repairEncounterId = null;
    state.stableRepairDestination = null;
    return false;
  }

  const heavy = world.freeCombatAiV164.heavy;
  const boat = world.freeHeavyPursuer.boat;
  const encounterId = String(heavy.encounterId ?? world.freeHeavyPursuer?.encounterId ?? boat.id);
  const clearance = achievableTurretRepairClearanceV171(world);
  const currentNearest = nearestPlayerDistance(world, boat);
  const bombIncoming = incomingBombThreat(world, boat);

  const savedUnsafe = !state.stableRepairDestination
    || nearestPlayerDistance(world, state.stableRepairDestination) < clearance;
  if (state.repairEncounterId !== encounterId || savedUnsafe) {
    state.repairEncounterId = encounterId;
    state.stableRepairDestination = safestStableRepairDestination(
      world,
      boat,
      clearance,
      Number(world.time) || 0,
    );
    emit(world, "heavy-turret-repair-route-v172",
      "Тяжёлый катер выбрал устойчивую точку отхода для ремонта установки.",
      [0, 1], {
        system: "turret",
        clearance,
        destination: {...state.stableRepairDestination},
        x: boat.x,
        y: boat.y,
      });
  }

  heavy.destination = {...state.stableRepairDestination};
  heavy.v167ReachableDestination = {...state.stableRepairDestination};
  heavy.v168SafeDestination = {...state.stableRepairDestination};

  if (currentNearest >= clearance && !bombIncoming) {
    const wasRepairing = heavy.phase === "breach-repairing-v166";
    removeEvents(world, eventStart, event => (
      event?.type === "heavy-tactical-mode-v168"
      && event.mode === "repair-aborted"
    ));
    heavy.phase = "breach-repairing-v166";
    heavy.repairProgress = Math.max(0, Number(heavy.repairProgress) || 0);
    boat.speed = 0;
    if (!wasRepairing) {
      emit(world, "heavy-turret-repair-safe-v172",
        `Тяжёлый катер разорвал дистанцию до ${Math.round(currentNearest)} метров, остановился и начал ремонт оружейной установки.`,
        [0, 1], {
          system: "turret",
          clearance,
          nearest: currentNearest,
          destination: {...state.stableRepairDestination},
          x: boat.x,
          y: boat.y,
        });
    }
    return true;
  }

  if (heavy.phase === "breach-repairing-v166") {
    heavy.phase = "breach-escaping-v166";
    heavy.repairProgress = Math.max(0, (Number(heavy.repairProgress) || 0) * 0.35);
  }
  boat.speed = Math.max(Number(boat.speed) || 0, 7.2);
  return true;
}

function directRange(combat) {
  return combat?.equipped === "pistol"
    ? COMBAT_TUNING.pistolRange
    : COMBAT_TUNING.automaticRange;
}

function selectedTargetId(world, playerIndex) {
  const combat = world.players?.[playerIndex]?.combat;
  const input = world.freeActivities?.inputs?.[playerIndex]
    || world.operationInputs?.[playerIndex]
    || world.inputs?.[playerIndex]
    || {};
  return input.targetId || combat?.lastTargetRequestId || combat?.lockedTargetId || null;
}

function physicalTarget(world, playerIndex, targetId) {
  if (!targetId) return null;
  return resolveCombatTarget(world, playerIndex, targetId, Infinity);
}

function targetDistance(world, playerIndex, target) {
  return distance(pointForPlayer(world, playerIndex), target?.point);
}

function targetEventForPlayer(event, playerIndex) {
  return event?.targets?.includes?.(playerIndex) || Number(event?.sourcePlayer) === playerIndex;
}

function removeMisleadingTargetEvents(world, eventStart, playerIndex) {
  removeEvents(world, eventStart, event => targetEventForPlayer(event, playerIndex) && (
    event?.type === "target-lost"
    || event?.type === "target-auto-locked"
  ));
}

function inputObjects(world, playerIndex) {
  const result = [];
  for (const candidate of [
    world.freeActivities?.inputs?.[playerIndex],
    world.operationInputs?.[playerIndex],
    world.inputs?.[playerIndex],
  ]) {
    if (candidate && !result.includes(candidate)) result.push(candidate);
  }
  return result;
}

export function suppressOutOfRangeDirectFireV172(world, state) {
  const saved = [];
  for (let index = 0; index < values(world.players).length; index += 1) {
    const combat = world.players?.[index]?.combat;
    if (!combat?.alive || !["pistol", "automatic"].includes(combat.equipped)) continue;
    const targetId = selectedTargetId(world, index);
    const target = physicalTarget(world, index, targetId);
    if (!target) continue;
    const metres = targetDistance(world, index, target);
    if (metres <= directRange(combat)) continue;
    for (const input of inputObjects(world, index)) {
      if (!input.attack) continue;
      saved.push({input, attack: input.attack});
      input.attack = false;
    }
    if (saved.length) state.lastOutOfRangeFireAt[index] = Number(world.time) || 0;
  }
  return saved;
}

function restoreSuppressedInputs(saved) {
  for (const item of saved || []) item.input.attack = item.attack;
}

export function preserveLongRangeTargetV172(world, state, eventStart = 0) {
  for (let index = 0; index < values(world.players).length; index += 1) {
    const combat = world.players?.[index]?.combat;
    if (!combat?.alive) continue;
    const targetId = selectedTargetId(world, index);
    if (!targetId) {
      delete state.targetLocks[index];
      continue;
    }
    const target = physicalTarget(world, index, targetId);
    if (!target) {
      delete state.targetLocks[index];
      continue;
    }

    const metres = targetDistance(world, index, target);
    if (metres <= COMBAT_TUNING.automaticRange) {
      delete state.targetLocks[index];
      continue;
    }

    removeMisleadingTargetEvents(world, eventStart, index);
    if (metres <= MEGA_BOMB_RANGE) {
      combat.lockedTargetId = target.id;
      const changed = state.targetLocks[index]?.id !== target.id || state.targetLocks[index]?.band !== "mega";
      state.targetLocks[index] = {id: target.id, band: "mega"};
      if (changed) {
        emit(world, "target-locked-long-range-v172",
          `Цель жива и захвачена на дистанции ${Math.round(metres)} метров. Автомат не достаёт, но дальняя мега-бомба может достать.`,
          [index], {
            sourcePlayer: index,
            targetId: target.id,
            targetKind: target.kind,
            distance: metres,
            maximumDirectRange: COMBAT_TUNING.automaticRange,
            maximumMegaBombRange: MEGA_BOMB_RANGE,
            x: target.point.x,
            y: target.point.y,
          });
      }
      continue;
    }

    if (combat.lockedTargetId === target.id) combat.lockedTargetId = null;
    const changed = state.targetLocks[index]?.id !== target.id || state.targetLocks[index]?.band !== "too-far";
    state.targetLocks[index] = {id: target.id, band: "too-far"};
    if (changed) {
      emit(world, "target-alive-out-of-range-v172",
        `Цель жива, но находится в ${Math.round(metres)} метрах. Даже мега-бомба действует только до ${MEGA_BOMB_RANGE} метров. Подойди ближе.`,
        [index], {
          sourcePlayer: index,
          targetId: target.id,
          targetKind: target.kind,
          distance: metres,
          maximumRange: MEGA_BOMB_RANGE,
          x: target.point.x,
          y: target.point.y,
        });
    }
  }
}

export function prepareCombatAiV172Overlay(world, helpers = {}) {
  const state = ensureState(world);
  state.frame = {
    eventStart: world.events?.length || 0,
    suppressedInputs: [],
  };
  applyCombatAiModelV171(world, 0, helpers);
  state.frame.suppressedInputs = suppressOutOfRangeDirectFireV172(world, state);
  return state;
}

export function finishCombatAiV172Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  applyCombatAiModelV171(world, Math.max(0, Number(dt) || 0), helpers);
  stabilizeTurretRecoveryV172(world, state, state.frame?.eventStart || 0);
  preserveLongRangeTargetV172(world, state, state.frame?.eventStart || 0);
  restoreSuppressedInputs(state.frame?.suppressedInputs);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV172(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV172Overlay(world, helpers);
  return finishCombatAiV172Overlay(world, dt, helpers);
}

export {MEGA_BOMB_RANGE, TARGET_MENU_RANGE};
