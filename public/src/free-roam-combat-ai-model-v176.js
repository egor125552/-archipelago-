"use strict";

import {applyCombatAiModelV175} from "./free-roam-combat-ai-model-v175.js?v=1";

const ADOPTION_LOOKAHEAD_SECONDS = 0.07;
const REPAIR_ABORT_CLEARANCE = 216;
const PHASE_EVENT_TYPES = new Set([
  "contract-threat-phase",
  "contract-threat-phase-two",
  "contract-threat-final-phase",
  "contract-threat-final-wave",
]);
const REPAIR_COMPLETE_TYPES = new Set([
  "heavy-repair-complete",
  "heavy-repair-complete-v166",
  "heavy-system-repaired",
]);

const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

function normalizedId(value) {
  return value === null || value === undefined || String(value) === "" ? null : String(value);
}

function ensureState(world) {
  world.freeCombatAiV176 ||= {
    frame: null,
    encounterId: null,
    phaseAnnouncements: {},
    repairAnnouncementKey: null,
    repairAnchor: null,
    heavyContractId: null,
  };
  const state = world.freeCombatAiV176;
  state.phaseAnnouncements ||= {};
  state.heavyContractId = normalizedId(state.heavyContractId);
  return state;
}

function directorEncounterId(world) {
  const director = world.freeThreatDirector;
  return director?.active ? normalizedId(director.encounterId) : null;
}

function directorContractId(world) {
  const director = world.freeThreatDirector;
  return director?.active ? normalizedId(director.contractId) : null;
}

function synchronizeEncounterState(world, state) {
  const encounterId = directorEncounterId(world);
  if (state.encounterId === encounterId) return;
  state.encounterId = encounterId;
  state.phaseAnnouncements = {};
  state.repairAnnouncementKey = null;
  state.repairAnchor = null;
}

function currentHeavyBoat(world) {
  const boat = world.freeHeavyPursuer?.boat;
  return boat?.active && !boat.destroyed && Number(boat.hull) > 0 ? boat : null;
}

function knownHeavyEncounterIds(world) {
  return [
    world.freeHeavyPursuer?.encounterId,
    world.freeCombatAiV164?.heavyEncounterId,
    world.freeCombatAiV164?.heavy?.encounterId,
    world.freeCombatAiV172?.repairEncounterId,
  ].map(normalizedId).filter(Boolean);
}

function knownHeavyContractIds(world) {
  const state = ensureState(world);
  return [
    state.heavyContractId,
    world.freeHeavyPursuer?.v176ContractId,
    currentHeavyBoat(world)?.v176ContractId,
    world.freeCombatAiV164?.heavy?.v176ContractId,
  ].map(normalizedId).filter(Boolean);
}

function stampHeavyContract(world, contractId) {
  const normalized = normalizedId(contractId);
  const boat = currentHeavyBoat(world);
  if (!normalized || !boat) return false;
  const state = ensureState(world);
  state.heavyContractId = normalized;
  world.freeHeavyPursuer.v176ContractId = normalized;
  boat.v176ContractId = normalized;
  if (world.freeCombatAiV164?.heavy) world.freeCombatAiV164.heavy.v176ContractId = normalized;
  return true;
}

export function bindHeavyOwnershipV176(world) {
  const boat = currentHeavyBoat(world);
  const director = world.freeThreatDirector;
  if (!boat || !director?.active || Number(director.level) < 5) return false;

  const contractId = directorContractId(world);
  if (!contractId) return false;

  const existingOwnership = knownHeavyContractIds(world);
  if (existingOwnership.length) return existingOwnership.every(value => value === contractId);

  const encounterId = directorEncounterId(world);
  const knownEncounterIds = knownHeavyEncounterIds(world);
  const encounterMatches = knownEncounterIds.length === 0
    || knownEncounterIds.every(value => value === encounterId);
  if (!director.heavyStarted && !encounterMatches) return false;
  return stampHeavyContract(world, contractId);
}

function heavyIsStale(world) {
  const boat = currentHeavyBoat(world);
  if (!boat) return false;
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5) return false;

  const contractId = directorContractId(world);
  const ownedContractIds = knownHeavyContractIds(world);
  if (contractId && ownedContractIds.length) {
    if (ownedContractIds.some(value => value !== contractId)) return true;
    return false;
  }

  const encounterId = directorEncounterId(world);
  const knownEncounterIds = knownHeavyEncounterIds(world);
  return Boolean(encounterId && knownEncounterIds.some(value => value !== encounterId));
}

function projectileSourceIds(projectile) {
  return [
    projectile?.sourceId,
    projectile?.sourceBoatId,
    projectile?.sourceActorId,
    projectile?.boatId,
    projectile?.actorId,
    projectile?.ownerId,
    projectile?.shooterId,
    projectile?.launcherId,
  ].map(normalizedId).filter(Boolean);
}

function projectileFromRemoved(projectile, removedIds) {
  return projectileSourceIds(projectile).some(id => removedIds.has(id));
}

function clearRepairState(world, state) {
  state.repairAnnouncementKey = null;
  state.repairAnchor = null;
  if (world.freeCombatAiV172) {
    world.freeCombatAiV172.repairEncounterId = null;
    world.freeCombatAiV172.stableRepairDestination = null;
    world.freeCombatAiV172.frame = null;
  }
  if (world.freeCombatAiV175) {
    world.freeCombatAiV175.repairCommitted = false;
    world.freeCombatAiV175.repairAnnouncementActive = false;
  }
}

export function retireStaleHeavyV176(world, reason = "stale-encounter", force = false) {
  const state = ensureState(world);
  if (!currentHeavyBoat(world) || (!force && !heavyIsStale(world))) return false;

  const boat = world.freeHeavyPursuer.boat;
  const oldEncounterIds = knownHeavyEncounterIds(world);
  const oldContractIds = knownHeavyContractIds(world);
  const removedActorIds = new Set(values(world.freeHostileActors?.actors)
    .filter(actor => String(actor?.boatId || "") === "heavy-pursuer")
    .map(actor => normalizedId(actor?.id))
    .filter(Boolean));

  world.freeHeavyPursuer.active = false;
  world.freeHeavyPursuer.boat = null;
  world.freeHeavyPursuer.projectiles = [];
  world.freeHeavyPursuer.v176ContractId = null;

  if (world.freeCombatAiV164) {
    world.freeCombatAiV164.heavy = null;
    world.freeCombatAiV164.heavyEncounterId = null;
    world.freeCombatAiV164.frame = null;
  }
  if (world.freeCombatAiV174) {
    world.freeCombatAiV174.frame = null;
    world.freeCombatAiV174.adoptedEncounterId = null;
  }
  clearRepairState(world, state);
  state.heavyContractId = null;

  if (world.freeHostileActors?.actors) {
    world.freeHostileActors.actors = values(world.freeHostileActors.actors).filter(actor => (
      String(actor?.boatId || "") !== "heavy-pursuer"
    ));
  }
  if (world.freeHostileActors?.projectiles && removedActorIds.size) {
    world.freeHostileActors.projectiles = values(world.freeHostileActors.projectiles)
      .filter(projectile => !projectileFromRemoved(projectile, removedActorIds));
  }
  if (world.freeThreatDirector?.assignments) delete world.freeThreatDirector.assignments[boat.id];
  if (world.freeThreatDirector?.actorAssignments) {
    for (const id of removedActorIds) delete world.freeThreatDirector.actorAssignments[id];
  }

  world.events ||= [];
  world.events.push({
    type: "heavy-stale-state-retired-v176",
    text: "",
    targets: [],
    at: world.time,
    operationEvent: true,
    reason,
    oldEncounterIds,
    oldContractIds,
    encounterId: world.freeThreatDirector?.encounterId ?? null,
    contractId: world.freeThreatDirector?.contractId ?? null,
    hull: boat.hull,
    engineHealth: boat.engineHealth,
    turretHealth: boat.turretHealth,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

function belongsToEncounter(id, encounterId, phase) {
  const value = String(id || "");
  return value.startsWith(`threat-reinforcement-${encounterId}-${phase}-`)
    || value.startsWith(`threat-phase-${encounterId}-${phase}-`);
}

function belongsToPrematurePhase(id, encounterId) {
  return belongsToEncounter(id, encounterId, 2) || belongsToEncounter(id, encounterId, 3);
}

function eventIsFresh(event, index, frame) {
  if (!frame) return true;
  if (index >= Math.max(0, Number(frame.eventStart) || 0)) return true;
  return Number(event?.at) >= (Number(frame.time) || 0) - 0.001;
}

function removeAssignments(assignments, removedIds) {
  if (!assignments || typeof assignments !== "object") return;
  for (const id of removedIds) delete assignments[id];
}

export function rollbackPrematureThreatPhasesV176(world, frame = null) {
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5 || director.heavyStarted) return false;
  const encounterId = String(director.encounterId ?? "");
  const intelligence = world.freeThreatIntelligence;
  const boats = values(world.freeEnemyBoats?.boats);
  const actors = values(world.freeHostileActors?.actors);

  const removedBoatIds = new Set(boats
    .filter(boat => belongsToPrematurePhase(boat?.id, encounterId))
    .map(boat => normalizedId(boat?.id))
    .filter(Boolean));
  for (const actor of actors) {
    const boatId = normalizedId(actor?.boatId);
    if (boatId && belongsToPrematurePhase(boatId, encounterId)) removedBoatIds.add(boatId);
  }

  const removedActorIds = new Set(actors
    .filter(actor => belongsToPrematurePhase(actor?.id, encounterId)
      || removedBoatIds.has(normalizedId(actor?.boatId)))
    .map(actor => normalizedId(actor?.id))
    .filter(Boolean));

  const hadPrematureState = Boolean(
    intelligence?.phase2Spawned
    || intelligence?.finalWaveSpawned
    || Number(intelligence?.phase) > 1
    || removedBoatIds.size
    || removedActorIds.size
  );
  if (!hadPrematureState) return false;

  if (world.freeEnemyBoats?.boats) {
    world.freeEnemyBoats.boats = boats.filter(boat => !removedBoatIds.has(normalizedId(boat?.id)));
  }
  if (world.freeHostileActors?.actors) {
    world.freeHostileActors.actors = actors.filter(actor => !removedActorIds.has(normalizedId(actor?.id)));
  }

  const removedSourceIds = new Set([...removedBoatIds, ...removedActorIds]);
  if (world.freeEnemyBoats?.projectiles) {
    world.freeEnemyBoats.projectiles = values(world.freeEnemyBoats.projectiles)
      .filter(projectile => !projectileFromRemoved(projectile, removedSourceIds));
  }
  if (world.freeHostileActors?.projectiles) {
    world.freeHostileActors.projectiles = values(world.freeHostileActors.projectiles)
      .filter(projectile => !projectileFromRemoved(projectile, removedSourceIds));
  }
  removeAssignments(director.assignments, removedBoatIds);
  removeAssignments(director.actorAssignments, removedActorIds);

  if (intelligence) {
    intelligence.encounterId = Number(director.encounterId) || 0;
    intelligence.phase = 1;
    intelligence.phase2StartedAt = 0;
    intelligence.phase2BaselineActors = 0;
    intelligence.phase2Spawned = false;
    intelligence.finalWaveSpawned = false;
    intelligence.nextBoatSerial = Math.max(1, Number(intelligence.nextBoatSerial) || 1);
  }

  const blockedHeavyTypes = new Set([
    "heavy-armour-breached",
    "heavy-breach-escape-v166",
    "heavy-breach-engine-repair-trapped-v166",
    "heavy-engine-repair-trapped-v166",
    "heavy-turret-repair-route-v172",
    "heavy-turret-repair-safe-v172",
    "heavy-repair-progress-v166",
    "heavy-repair-complete-v166",
  ]);
  world.events = values(world.events).filter((event, index) => {
    if (!eventIsFresh(event, index, frame)) return true;
    const type = String(event?.type || "");
    if (type === "contract-threat-phase-two"
      || type === "contract-threat-final-wave"
      || type === "contract-threat-final-phase") return false;
    if (type === "contract-threat-phase" && [2, 3].includes(Number(event.phase))) return false;
    if (blockedHeavyTypes.has(type)) return false;
    const references = [
      event?.sourceId,
      event?.sourceBoatId,
      event?.sourceActorId,
      event?.boatId,
      event?.actorId,
      event?.targetId,
    ].map(normalizedId).filter(Boolean);
    if (references.some(id => removedSourceIds.has(id))) return false;
    return true;
  });
  return true;
}

function nearestLivingPlayerDistance(world, boat) {
  const points = values(world.players).map((player, index) => {
    if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false) return null;
    if (["boat", "roof"].includes(player.mode)) {
      return values(world.boats).find(candidate => String(candidate?.id) === String(player.activeBoat)) || player;
    }
    return player;
  }).filter(Boolean);
  return points.length ? Math.min(...points.map(point => distance(point, boat))) : Infinity;
}

function actualRepairAbort(event) {
  return event?.type === "heavy-turret-repair-aborted-v172"
    || (event?.type === "heavy-tactical-mode-v168" && event.mode === "repair-aborted");
}

function resetRepairAnnouncement(world, state) {
  state.repairAnnouncementKey = null;
  state.repairAnchor = null;
  if (world.freeCombatAiV175) world.freeCombatAiV175.repairAnnouncementActive = false;
}

export function normalizeRepairLifecycleV176(world, frame = null) {
  const state = ensureState(world);
  const boat = currentHeavyBoat(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const committed = Boolean(world.freeCombatAiV175?.repairCommitted)
    && heavy?.repairSystem === "turret"
    && Number(boat?.turretHealth) <= 0;
  const encounterId = String(heavy?.encounterId ?? world.freeThreatDirector?.encounterId ?? "active");
  const key = `${encounterId}:turret`;
  let lastLifecycleEvent = null;

  world.events = values(world.events).filter((event, index) => {
    if (!eventIsFresh(event, index, frame)) return true;
    if (actualRepairAbort(event)) {
      resetRepairAnnouncement(world, state);
      lastLifecycleEvent = "abort";
      return true;
    }
    if (REPAIR_COMPLETE_TYPES.has(event?.type)) {
      resetRepairAnnouncement(world, state);
      lastLifecycleEvent = "complete";
      return true;
    }
    if (event?.type !== "heavy-turret-repair-safe-v172") return true;
    if (!committed) return false;
    if (state.repairAnnouncementKey === key) return false;
    state.repairAnnouncementKey = key;
    if (world.freeCombatAiV175) world.freeCombatAiV175.repairAnnouncementActive = true;
    lastLifecycleEvent = "start";
    return true;
  });

  if (!boat || !heavy || heavy.repairSystem !== "turret" || Number(boat.turretHealth) > 0) {
    resetRepairAnnouncement(world, state);
    return false;
  }
  if (!committed
    || ["abort", "complete"].includes(lastLifecycleEvent)
    || nearestLivingPlayerDistance(world, boat) < REPAIR_ABORT_CLEARANCE) {
    state.repairAnchor = null;
    return false;
  }

  if (!state.repairAnchor || state.repairAnchor.key !== key) {
    state.repairAnchor = {
      key,
      x: Number(boat.x) || 0,
      y: Number(boat.y) || 0,
      heading: Number(boat.heading) || 0,
    };
  } else {
    boat.x = state.repairAnchor.x;
    boat.y = state.repairAnchor.y;
    boat.heading = state.repairAnchor.heading;
  }
  boat.speed = 0;
  heavy.phase = "breach-repairing-v166";
  return true;
}

function phaseForEvent(event) {
  if (Number(event?.phase) > 0) return Number(event.phase);
  const type = String(event?.type || "");
  if (type.includes("final")) return 3;
  if (type.includes("two")) return 2;
  return 0;
}

export function normalizePhaseAnnouncementsV176(world, frame = null) {
  const state = ensureState(world);
  const encounterId = String(world.freeThreatDirector?.encounterId ?? "active");
  world.events = values(world.events).filter((event, index) => {
    if (!eventIsFresh(event, index, frame) || !PHASE_EVENT_TYPES.has(event?.type)) return true;
    const phase = phaseForEvent(event);
    if (!phase) return true;
    const key = `${encounterId}:${phase}`;
    if (state.phaseAnnouncements[key]) return false;
    state.phaseAnnouncements[key] = Number(event.at ?? world.time) || 0;
    return true;
  });
}

function frameSnapshot(world) {
  const boat = currentHeavyBoat(world);
  return {
    eventStart: values(world.events).length,
    time: Number(world.time) || 0,
    directorEncounterId: directorEncounterId(world),
    directorContractId: directorContractId(world),
    heavyReference: boat,
    heavyEncounterIds: knownHeavyEncounterIds(world),
    heavyContractIds: knownHeavyContractIds(world),
  };
}

function staleAcrossContractBoundary(world, frame) {
  const boat = currentHeavyBoat(world);
  if (!frame?.heavyReference || boat !== frame.heavyReference) return false;
  const before = normalizedId(frame.directorContractId);
  const after = directorContractId(world);
  return Boolean(before && after && before !== after);
}

function intendedHeavySchedule(world) {
  const director = world.freeThreatDirector;
  return director ? {
    heavyStarted: Boolean(director.heavyStarted),
    heavyStartsAt: Number(director.heavyStartsAt) || 0,
  } : null;
}

function restoreHeavySchedule(world, schedule) {
  const director = world.freeThreatDirector;
  if (!director || !schedule) return;
  director.heavyStarted = schedule.heavyStarted;
  director.heavyStartsAt = schedule.heavyStartsAt;
}

export function prepareCombatAiV176Overlay(world, helpers = {}) {
  const state = ensureState(world);
  synchronizeEncounterState(world, state);
  state.frame = frameSnapshot(world);
  bindHeavyOwnershipV176(world);
  retireStaleHeavyV176(world, "pre-step-stale-encounter");
  rollbackPrematureThreatPhasesV176(world, state.frame);
  applyCombatAiModelV175(world, 0, helpers);
  return state;
}

export function finishCombatAiV176Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  const frame = state.frame || frameSnapshot(world);
  synchronizeEncounterState(world, state);
  bindHeavyOwnershipV176(world);

  if (staleAcrossContractBoundary(world, frame)) {
    retireStaleHeavyV176(world, "contract-changed-during-step", true);
  } else {
    retireStaleHeavyV176(world, "post-step-stale-encounter");
  }
  rollbackPrematureThreatPhasesV176(world, frame);

  const schedule = intendedHeavySchedule(world);
  applyCombatAiModelV175(world, Math.max(0, Number(dt) || 0), helpers);

  const retiredAfterBase = retireStaleHeavyV176(world, "base-reintroduced-stale-heavy");
  if (retiredAfterBase) restoreHeavySchedule(world, schedule);
  rollbackPrematureThreatPhasesV176(world, frame);
  bindHeavyOwnershipV176(world);

  normalizeRepairLifecycleV176(world, frame);
  normalizePhaseAnnouncementsV176(world, frame);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV176(world, dt, helpers = {}) {
  return (Number(dt) || 0) <= 0
    ? prepareCombatAiV176Overlay(world, helpers)
    : finishCombatAiV176Overlay(world, dt, helpers);
}

export {ADOPTION_LOOKAHEAD_SECONDS, REPAIR_ABORT_CLEARANCE};
