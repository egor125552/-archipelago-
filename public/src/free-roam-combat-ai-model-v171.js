"use strict";

import {applyCombatAiModelV170} from "./free-roam-combat-ai-model-v170.js?v=1";

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

// The automatic reaches 220 metres. The heavy boat only needs to leave the
// direct automatic-fire envelope before it may repair. A launched mega-bomb
// is handled separately and can still interrupt that repair from long range.
export const TURRET_REPAIR_CLEARANCE_V171 = 232;
const MIN_ACHIEVABLE_CLEARANCE = 204;
const ESCAPE_SPEED = 14.6;
const ESCAPE_INITIAL_SPEED = 7.2;
const POSITION_EPSILON = 0.22;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiV171 ||= {
    frame: null,
    retreatSerial: 0,
    lastForcedEscapeAt: -999,
  };
  const state = world.freeCombatAiV171;
  if (!Number.isFinite(state.retreatSerial)) state.retreatSerial = 0;
  if (!Number.isFinite(state.lastForcedEscapeAt)) state.lastForcedEscapeAt = -999;
  return state;
}

function pointForPlayer(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return world.boats?.find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function livingPoints(world) {
  return (world.players || [])
    .map((player, index) => ({player, index, point: pointForPlayer(world, index)}))
    .filter(({player, index, point}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && point);
}

function nearestPlayerDistance(world, point) {
  const living = livingPoints(world);
  return living.length ? Math.min(...living.map(item => distance(point, item.point))) : Infinity;
}

function incomingBombThreat(world, boat) {
  return (world.freeMegaBombs?.projectiles || []).some(projectile => {
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

function retreatCandidates() {
  const points = [];
  for (const x of [16, 42, 88, 150, 210, 272, 334, 380, 404]) {
    for (const y of [86, 108, 150, 200, 250, 292, 308]) points.push({x, y});
  }
  return points;
}

export function achievableTurretRepairClearanceV171(world) {
  const candidates = retreatCandidates();
  const farthest = Math.max(...candidates.map(point => nearestPlayerDistance(world, point)));
  if (!Number.isFinite(farthest)) return TURRET_REPAIR_CLEARANCE_V171;
  return clamp(farthest - 7, MIN_ACHIEVABLE_CLEARANCE, TURRET_REPAIR_CLEARANCE_V171);
}

function safestDestination(world, boat, state) {
  state.retreatSerial += 1;
  const living = livingPoints(world);
  return retreatCandidates()
    .map(point => {
      const nearest = living.length ? Math.min(...living.map(item => distance(point, item.point))) : 999;
      const travel = distance(point, boat);
      const edge = Math.min(point.x - 14, 406 - point.x, point.y - 84, 310 - point.y);
      const variation = ((point.x * 31 + point.y * 17 + state.retreatSerial * 23) % 19) * 0.01;
      return {point, travel, score: nearest * 5 + Math.min(150, travel) - edge * 0.08 + variation};
    })
    .filter(item => item.travel >= 20)
    .sort((left, right) => right.score - left.score)[0]?.point
    || {x: clamp(boat.x, 16, 404), y: clamp(boat.y, 86, 308)};
}

function moveTo(boat, destination, speed, dt) {
  const desired = bearing(boat, destination);
  const error = wrapDeg(desired - (Number(boat.heading) || 0));
  boat.heading = wrapDeg((Number(boat.heading) || 0) + clamp(error, -76 * dt, 76 * dt));
  const desiredSpeed = Math.abs(error) > 125 ? speed * 0.68 : speed;
  boat.speed += clamp(desiredSpeed - (Number(boat.speed) || 0), -12 * dt, 14 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp((Number(boat.x) || 0) + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp((Number(boat.y) || 0) - Math.cos(angle) * boat.speed * dt, 84, 310);
}

function removeWrongAbortEvent(world, eventStart) {
  const start = Math.max(0, Number(eventStart) || 0);
  const prefix = (world.events || []).slice(0, start);
  const filtered = (world.events || []).slice(start).filter(event => !(
    event?.type === "heavy-tactical-mode-v168"
    && event.mode === "repair-aborted"
  ));
  world.events = [...prefix, ...filtered];
}

function restoreRepairProgress(heavy, frame) {
  const reduced = Math.max(0, Number(heavy.repairProgress) || 0);
  const inferredBeforeAbort = reduced > 0 ? reduced / 0.35 : 0;
  heavy.repairProgress = Math.max(0, Number(frame?.repairProgress) || 0, inferredBeforeAbort);
}

function turretRepairApplicable(heavy, boat) {
  return Boolean(
    heavy
    && boat
    && boat.active
    && !boat.destroyed
    && Number(boat.hull) > 0
    && heavy.repairSystem === "turret"
    && Number(boat.turretHealth) <= 0
    && Number(boat.engineHealth) > 0
  );
}

export function stabilizeTurretRepairV171(world, state, dt, frame = null) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  if (!turretRepairApplicable(heavy, boat)) return false;

  const now = Number(world.time) || 0;
  const clearance = achievableTurretRepairClearanceV171(world);
  const nearest = nearestPlayerDistance(world, boat);
  const bombIncoming = incomingBombThreat(world, boat);

  // V168 used the 320-metre mega-bomb range as the ordinary repair distance.
  // That made repair impossible in much of the map and caused endless
  // repair-abort loops. If the boat is already outside automatic range and no
  // bomb is actually incoming, keep the legitimate repair instead.
  if (
    frame?.phase === "breach-repairing-v166"
    && heavy.phase === "breach-escaping-v166"
    && nearest >= clearance
    && !bombIncoming
  ) {
    removeWrongAbortEvent(world, frame.eventStart);
    restoreRepairProgress(heavy, frame);
    heavy.phase = "breach-repairing-v166";
    boat.speed = 0;
    if (world.freeCombatAiV168) world.freeCombatAiV168.mode = "turret-repair-safe-v171";
    return true;
  }

  if (heavy.phase === "breach-repairing-v166" && (nearest < clearance || bombIncoming)) {
    heavy.phase = "breach-escaping-v166";
    heavy.repairProgress = Math.max(0, (Number(heavy.repairProgress) || 0) * 0.35);
    heavy.destination = safestDestination(world, boat, state);
    heavy.v167ReachableDestination = {...heavy.destination};
    heavy.v168SafeDestination = {...heavy.destination};
    boat.speed = Math.max(Number(boat.speed) || 0, ESCAPE_INITIAL_SPEED);
    if (now - state.lastForcedEscapeAt >= 1.2) {
      state.lastForcedEscapeAt = now;
      emit(world, "heavy-turret-repair-escape-v171", bombIncoming
        ? "Тяжёлый катер заметил летящую мега-бомбу, сорвал ремонт установки и немедленно уходит."
        : "Ты подошёл в зону огня. Исправный двигатель тяжёлого катера немедленно уводит его от тебя перед новым ремонтом.",
      [0, 1], {x: boat.x, y: boat.y, clearance, nearest});
    }
  }

  if (heavy.phase !== "breach-escaping-v166") return false;

  const destinationUnsafe = !heavy.destination
    || distance(boat, heavy.destination) <= 8
    || nearestPlayerDistance(world, heavy.destination) < clearance;
  if (destinationUnsafe) {
    heavy.destination = safestDestination(world, boat, state);
    heavy.v167ReachableDestination = {...heavy.destination};
    heavy.v168SafeDestination = {...heavy.destination};
  }

  boat.speed = Math.max(Number(boat.speed) || 0, ESCAPE_INITIAL_SPEED);
  const movedByEarlierLayers = frame?.position
    ? distance(frame.position, boat)
    : Infinity;
  if (dt > 0 && movedByEarlierLayers <= POSITION_EPSILON) {
    moveTo(boat, heavy.destination, ESCAPE_SPEED, dt);
  }
  return true;
}

export function prepareCombatAiV171Overlay(world, helpers = {}) {
  const state = ensureState(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  state.frame = {
    eventStart: world.events?.length || 0,
    phase: heavy?.phase || null,
    repairProgress: Number(heavy?.repairProgress) || 0,
    position: boat ? {x: Number(boat.x) || 0, y: Number(boat.y) || 0} : null,
  };
  applyCombatAiModelV170(world, 0, helpers);
  return state;
}

export function finishCombatAiV171Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  applyCombatAiModelV170(world, Math.max(0, Number(dt) || 0), helpers);
  stabilizeTurretRepairV171(world, state, Math.max(0, Number(dt) || 0), state.frame);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV171(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV171Overlay(world, helpers);
  return finishCombatAiV171Overlay(world, dt, helpers);
}
