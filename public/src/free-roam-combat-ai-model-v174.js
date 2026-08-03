"use strict";

import {applyCombatAiModelV173} from "./free-roam-combat-ai-model-v173.js?v=1";
import {addEliteActor, ensureHostileActors} from "./free-roam-hostile-actors.js?v=2";

const HEAVY_START_LOOKAHEAD_SECONDS = 0.06;
const MOVING_PHASES = new Set([
  "approach",
  "retreating",
  "returning",
  "breach-escaping-v166",
  "breach-returning-v166",
]);

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function clonePoint(point) {
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? {x: Number(point.x), y: Number(point.y)}
    : null;
}

function cloneHeavyState(heavy) {
  if (!heavy || typeof heavy !== "object") return null;
  return {
    ...heavy,
    destination: clonePoint(heavy.destination),
    combatPoint: clonePoint(heavy.combatPoint),
    v167ReachableDestination: clonePoint(heavy.v167ReachableDestination),
    v168SafeDestination: clonePoint(heavy.v168SafeDestination),
  };
}

function cloneBoat(boat) {
  return boat && typeof boat === "object" ? {...boat} : null;
}

function cloneProjectiles(projectiles) {
  return values(projectiles).map(projectile => ({...projectile}));
}

function ensureState(world) {
  world.freeCombatAiV174 ||= {
    frame: null,
    adoptedEncounterId: null,
  };
  return world.freeCombatAiV174;
}

function livingPlayerIndex(world, preferred = null) {
  if (Number.isInteger(preferred)
    && world.freeActivities?.presence?.[preferred] !== false
    && world.players?.[preferred]?.combat?.alive) return preferred;
  for (let index = 0; index < values(world.players).length; index += 1) {
    if (world.freeActivities?.presence?.[index] === false) continue;
    if (world.players?.[index]?.combat?.alive) return index;
  }
  return Number.isInteger(preferred) ? preferred : 0;
}

function eliteId(encounterId) {
  return `elite-${encounterId}`;
}

function ensureEliteForAdoptedHeavy(world, boat, encounterId, targetPlayer) {
  const hostile = ensureHostileActors(world);
  const id = eliteId(encounterId);
  const existing = values(hostile.actors).find(actor => String(actor?.id) === id && actor.active && !actor.destroyed);
  if (existing) {
    existing.boatId = boat.id;
    existing.targetPlayer = targetPlayer;
    if (existing.state === "aboard") {
      existing.x = boat.x;
      existing.y = boat.y;
      existing.heading = boat.heading;
    }
    return existing;
  }
  return addEliteActor(world, boat, targetPlayer, encounterId);
}

function synchronizeEncounterIdentity(world, encounterId) {
  const pursuer = world.freeHeavyPursuer;
  const ai = world.freeCombatAiV164;
  if (pursuer) pursuer.encounterId = encounterId;
  if (ai?.heavy) ai.heavy.encounterId = encounterId;
  if (ai) ai.heavyEncounterId = encounterId;
  const repair = world.freeCombatAiV172;
  if (repair?.repairEncounterId != null) repair.repairEncounterId = String(encounterId);
}

export function adoptExistingHeavyForThreatV174(world, lookaheadSeconds = HEAVY_START_LOOKAHEAD_SECONDS) {
  const director = world.freeThreatDirector;
  const pursuer = world.freeHeavyPursuer;
  const boat = pursuer?.boat;
  const aiHeavy = world.freeCombatAiV164?.heavy;
  if (!director?.active || Number(director.level) < 5 || director.heavyStarted) return false;
  if (!boat?.active || boat.destroyed || Number(boat.hull) <= 0) return false;
  if (!aiHeavy) return false;

  const startAt = Number(director.heavyStartsAt) || 0;
  const now = Number(world.time) || 0;
  if (now + Math.max(0, Number(lookaheadSeconds) || 0) < startAt) return false;

  const encounterId = Number(director.encounterId) || pursuer.encounterId || aiHeavy.encounterId || boat.id;
  const assigned = Number(director.assignments?.[boat.id]);
  const targetPlayer = livingPlayerIndex(world, Number.isInteger(assigned) ? assigned : Number(boat.targetPlayer));

  director.heavyStarted = true;
  director.heavyStartsAt = 0;
  director.assignments ||= {};
  director.assignments[boat.id] = targetPlayer;
  director.lastPoint = {x: Number(boat.x) || 0, y: Number(boat.y) || 0};
  boat.targetPlayer = targetPlayer;
  synchronizeEncounterIdentity(world, encounterId);
  ensureEliteForAdoptedHeavy(world, boat, encounterId, targetPlayer);

  const state = ensureState(world);
  if (String(state.adoptedEncounterId) !== String(encounterId)) {
    state.adoptedEncounterId = encounterId;
    emit(world, "contract-threat-phase",
      "Вторая фаза. Уже находящийся в бою тяжёлый катер продолжает бой без восстановления, а элитный стрелок готовится к высадке.",
      [0, 1], {
        level: director.level,
        phase: 2,
        encounterId,
        continuityV174: true,
        heavyPhase: aiHeavy.phase,
        repairSystem: aiHeavy.repairSystem || null,
        x: boat.x,
        y: boat.y,
      });
  }
  return true;
}

function frameSnapshot(world) {
  const pursuer = world.freeHeavyPursuer;
  const boat = pursuer?.boat;
  const heavy = world.freeCombatAiV164?.heavy;
  if (!boat?.active || boat.destroyed || Number(boat.hull) <= 0 || !heavy) return null;
  return {
    eventStart: world.events?.length || 0,
    boatReference: boat,
    boat: cloneBoat(boat),
    heavy: cloneHeavyState(heavy),
    pursuerEncounterId: pursuer.encounterId,
    projectiles: cloneProjectiles(pursuer.projectiles),
    nextProjectileId: pursuer.nextProjectileId,
    repairEncounterId: world.freeCombatAiV172?.repairEncounterId ?? null,
    stableRepairDestination: clonePoint(world.freeCombatAiV172?.stableRepairDestination),
  };
}

function duplicateSpawnEvent(event) {
  return ["heavy-pursuer-arrived", "heavy-pursuer-approaching"].includes(event?.type);
}

function removeDuplicateSpawnEvents(world, start, wasRepairing) {
  const before = values(world.events).slice(0, start);
  const after = values(world.events).slice(start).filter(event => {
    if (duplicateSpawnEvent(event)) return false;
    if (wasRepairing && event?.type === "heavy-tactical-mode-v168" && event.mode === "repair-aborted") return false;
    return true;
  });
  world.events = [...before, ...after];
  for (const event of after) {
    if (event?.type !== "contract-threat-phase" || Number(event.phase) !== 2) continue;
    event.text = "Вторая фаза. Уже находящийся в бою тяжёлый катер продолжает бой без восстановления, а элитный стрелок готовится к высадке.";
  }
}

function resetLooksLikeReplacement(frame, world, newEvents) {
  const current = world.freeHeavyPursuer?.boat;
  if (!current || !frame?.boat) return false;
  const objectReplaced = current !== frame.boatReference;
  const encounterChanged = String(world.freeHeavyPursuer?.encounterId) !== String(frame.pursuerEncounterId);
  const healthRestored = Number(current.hull) > Number(frame.boat.hull) + 80
    || Number(current.engineHealth) > Number(frame.boat.engineHealth) + 45
    || Number(current.turretHealth) > Number(frame.boat.turretHealth) + 60;
  return newEvents.some(duplicateSpawnEvent) && (objectReplaced || encounterChanged || healthRestored);
}

export function restoreHeavyAfterDuplicateSpawnV174(world, frame) {
  if (!frame?.boat || !frame.heavy) return false;
  const start = Math.max(0, Number(frame.eventStart) || 0);
  const newEvents = values(world.events).slice(start);
  if (!resetLooksLikeReplacement(frame, world, newEvents)) return false;

  const currentEncounterId = Number(world.freeThreatDirector?.encounterId)
    || world.freeHeavyPursuer?.encounterId
    || frame.pursuerEncounterId
    || frame.heavy.encounterId;
  const targetPlayer = livingPlayerIndex(world,
    Number(world.freeThreatDirector?.assignments?.[frame.boat.id] ?? frame.boat.targetPlayer));

  Object.assign(frame.boatReference, frame.boat, {targetPlayer});
  world.freeHeavyPursuer.boat = frame.boatReference;
  world.freeHeavyPursuer.active = true;
  world.freeHeavyPursuer.encounterId = currentEncounterId;
  world.freeHeavyPursuer.projectiles = frame.projectiles.map(projectile => ({...projectile}));
  world.freeHeavyPursuer.nextProjectileId = frame.nextProjectileId;

  world.freeCombatAiV164 ||= {};
  world.freeCombatAiV164.heavy = {...cloneHeavyState(frame.heavy), encounterId: currentEncounterId};
  world.freeCombatAiV164.heavyEncounterId = currentEncounterId;
  if (world.freeCombatAiV172) {
    world.freeCombatAiV172.repairEncounterId = frame.repairEncounterId == null
      ? frame.repairEncounterId
      : String(currentEncounterId);
    world.freeCombatAiV172.stableRepairDestination = clonePoint(frame.stableRepairDestination);
  }

  const restoredHeavy = world.freeCombatAiV164.heavy;
  if (restoredHeavy.phase === "breach-repairing-v166" || restoredHeavy.phase === "repairing") {
    frame.boatReference.speed = 0;
  } else if (MOVING_PHASES.has(restoredHeavy.phase) && Number(frame.boatReference.engineHealth) > 0) {
    frame.boatReference.speed = Number(frame.boat.speed) || 0;
  }

  removeDuplicateSpawnEvents(world, start,
    ["breach-repairing-v166", "repairing"].includes(frame.heavy.phase));
  ensureEliteForAdoptedHeavy(world, frame.boatReference, currentEncounterId, targetPlayer);
  emit(world, "heavy-pursuer-continuity-restored-v174",
    "Тяжёлый катер не получил повторное здоровье. Его ремонт, координаты и текущий манёвр сохранены.",
    [0, 1], {
      encounterId: currentEncounterId,
      phase: restoredHeavy.phase,
      repairSystem: restoredHeavy.repairSystem || null,
      hull: frame.boatReference.hull,
      x: frame.boatReference.x,
      y: frame.boatReference.y,
      speed: frame.boatReference.speed,
    });
  return true;
}

export function prepareCombatAiV174Overlay(world, helpers = {}) {
  const state = ensureState(world);
  adoptExistingHeavyForThreatV174(world);
  state.frame = frameSnapshot(world);
  applyCombatAiModelV173(world, 0, helpers);
  return state;
}

export function finishCombatAiV174Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  applyCombatAiModelV173(world, Math.max(0, Number(dt) || 0), helpers);
  restoreHeavyAfterDuplicateSpawnV174(world, state.frame);
  adoptExistingHeavyForThreatV174(world, 0);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV174(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV174Overlay(world, helpers);
  return finishCombatAiV174Overlay(world, dt, helpers);
}
