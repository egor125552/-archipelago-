"use strict";

import {applyCombatAiModelV175} from "./free-roam-combat-ai-model-v175.js?v=1";

const ADOPTION_LOOKAHEAD_SECONDS = 0.07;
const REPAIR_START_CLEARANCE = 236;
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

const HEAVY_TARGET_IDS = new Set(["heavy-pursuer", "heavy-turret", "heavy-engine"]);

function filterCollection(collection, keep) {
  if (Array.isArray(collection)) return collection.filter(keep);
  if (collection && typeof collection === "object") {
    for (const [key, value] of Object.entries(collection)) {
      if (!keep(value)) delete collection[key];
    }
  }
  return collection;
}

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

function ensureState(world) {
  world.freeCombatAiV176 ||= {
    frame: null,
    encounterId: null,
    phaseAnnouncements: {},
    repairAnnouncementKey: null,
    repairAnchor: null,
  };
  const state = world.freeCombatAiV176;
  state.phaseAnnouncements ||= {};
  return state;
}

function directorEncounterId(world) {
  const director = world.freeThreatDirector;
  return director?.active ? String(director.encounterId ?? "") : null;
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
  ].filter(value => value !== null && value !== undefined && String(value) !== "").map(String);
}

function heavyIsStale(world) {
  const boat = currentHeavyBoat(world);
  if (!boat) return false;
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5) return false;

  const encounterId = String(director.encounterId ?? "");
  const knownIds = knownHeavyEncounterIds(world);
  if (knownIds.some(value => value !== encounterId)) return true;

  if (!director.heavyStarted && knownIds.length > 0) {
    const startsAt = Number(director.heavyStartsAt) || 0;
    const now = Number(world.time) || 0;
    const dueForSameEncounterAdoption = knownIds.every(value => value === encounterId)
      && now + ADOPTION_LOOKAHEAD_SECONDS >= startsAt;
    return !dueForSameEncounterAdoption;
  }
  return false;
}

function clearRepairState(world, state) {
  state.repairAnnouncementKey = null;
  state.repairAnchor = null;
  if (world.freeCombatAiV172) {
    world.freeCombatAiV172.repairEncounterId = null;
    world.freeCombatAiV172.stableRepairDestination = null;
    world.freeCombatAiV172.frame = null;
    world.freeCombatAiV172.targetLocks = {};
  }
  if (world.freeCombatAiV175) {
    world.freeCombatAiV175.repairCommitted = false;
    world.freeCombatAiV175.repairAnnouncementActive = false;
  }
}

function clearStaleHeavyTargets(world) {
  for (const player of values(world.players)) {
    const combat = player?.combat;
    if (!combat) continue;
    if (HEAVY_TARGET_IDS.has(String(combat.lockedTargetId || ""))) combat.lockedTargetId = null;
    if (HEAVY_TARGET_IDS.has(String(combat.lastTargetRequestId || ""))) combat.lastTargetRequestId = null;
  }
  for (const collection of [
    world.freeActivities?.inputs,
    world.operationInputs,
    world.inputs,
  ]) {
    for (const input of values(collection)) {
      if (HEAVY_TARGET_IDS.has(String(input?.targetId || ""))) input.targetId = null;
    }
  }
}

export function retireStaleHeavyV176(world, reason = "stale-encounter", force = false) {
  const state = ensureState(world);
  if (!currentHeavyBoat(world) || (!force && !heavyIsStale(world))) return false;

  const boat = world.freeHeavyPursuer.boat;
  const oldEncounterIds = knownHeavyEncounterIds(world);
  world.freeHeavyPursuer.active = false;
  world.freeHeavyPursuer.boat = null;
  world.freeHeavyPursuer.encounterId = null;
  world.freeHeavyPursuer.projectiles = [];
  world.freeHeavyPursuer.nextProjectileId = 1;

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
  clearStaleHeavyTargets(world);

  if (world.freeHostileActors?.actors) {
    world.freeHostileActors.actors = values(world.freeHostileActors.actors).filter(actor => (
      String(actor?.boatId || "") !== "heavy-pursuer"
    ));
  }
  if (world.freeThreatDirector?.assignments) delete world.freeThreatDirector.assignments[boat.id];

  world.events ||= [];
  world.events.push({
    type: "heavy-stale-state-retired-v176",
    text: "",
    targets: [],
    at: world.time,
    operationEvent: true,
    reason,
    oldEncounterIds,
    encounterId: world.freeThreatDirector?.encounterId ?? null,
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

function eventIsFresh(event, index, frame) {
  if (!frame) return true;
  if (index >= Math.max(0, Number(frame.eventStart) || 0)) return true;
  return Number(event?.at) >= (Number(frame.time) || 0) - 0.001;
}

export function rollbackPrematureThreatPhasesV176(world, frame = null) {
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5 || director.heavyStarted) return false;
  const encounterId = String(director.encounterId ?? "");
  const intelligence = world.freeThreatIntelligence;
  const isPrematureBoat = boat => belongsToEncounter(boat?.id, encounterId, 2)
    || belongsToEncounter(boat?.id, encounterId, 3);
  const isPrematureActorId = actor => belongsToEncounter(actor?.id, encounterId, 2)
    || belongsToEncounter(actor?.id, encounterId, 3);
  const hadPrematureState = Boolean(
    intelligence?.phase2Spawned
    || intelligence?.finalWaveSpawned
    || Number(intelligence?.phase) > 1
    || values(world.freeEnemyBoats?.boats).some(isPrematureBoat)
    || values(world.freeThreatDirector?.boats).some(isPrematureBoat)
    || values(world.freeHostileActors?.actors).some(isPrematureActorId)
  );
  if (!hadPrematureState) return false;

  const removedBoatIds = new Set();
  const keepBoat = boat => {
    if (!isPrematureBoat(boat)) return true;
    removedBoatIds.add(String(boat?.id || ""));
    return false;
  };
  if (world.freeEnemyBoats?.boats) world.freeEnemyBoats.boats = filterCollection(world.freeEnemyBoats.boats, keepBoat);
  if (world.freeThreatDirector?.boats) world.freeThreatDirector.boats = filterCollection(world.freeThreatDirector.boats, keepBoat);

  const removedActorIds = new Set();
  if (world.freeHostileActors?.actors) {
    world.freeHostileActors.actors = filterCollection(world.freeHostileActors.actors, actor => {
      const remove = isPrematureActorId(actor) || removedBoatIds.has(String(actor?.boatId || ""));
      if (remove) removedActorIds.add(String(actor?.id || ""));
      return !remove;
    });
  }
  if (world.freeHostileActors?.projectiles) {
    world.freeHostileActors.projectiles = filterCollection(world.freeHostileActors.projectiles, projectile => !removedActorIds.has(String(
      projectile?.sourceActorId
        ?? projectile?.ownerId
        ?? projectile?.actorId
        ?? "",
      )) && !removedBoatIds.has(String(
        projectile?.sourceBoatId
        ?? projectile?.boatId
        ?? "",
      )),
    );
  }
  if (world.freeEnemyBoats?.projectiles) {
    world.freeEnemyBoats.projectiles = filterCollection(
      world.freeEnemyBoats.projectiles,
      projectile => !removedBoatIds.has(String(
        projectile?.sourcePursuerId
        ?? projectile?.sourceBoatId
        ?? projectile?.boatId
        ?? "",
      )),
     );
  }
  if (director.assignments) {
    for (const boatId of removedBoatIds) delete director.assignments[boatId];
  }

  if (intelligence) {
    intelligence.encounterId = Number(director.encounterId) || 0;
    intelligence.phase = 1;
    intelligence.phase2StartedAt = 0;
    intelligence.phase2BaselineActors = 0;
    intelligence.phase2Spawned = false;
    intelligence.finalWaveSpawned = false;
    intelligence.nextBoatSerial = 1;
  }

  world.events = values(world.events).filter((event, index) => {
    if (!eventIsFresh(event, index, frame)) return true;
    const type = String(event?.type || "");
    if (type === "contract-threat-phase-two"
      || type === "contract-threat-final-wave"
      || type === "contract-threat-final-phase") return false;
    if (type === "contract-threat-phase" && Number(event.phase) >= 2) return false;
    if (type.startsWith("heavy-") && type !== "heavy-stale-state-retired-v176") return false;
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

export function normalizeRepairLifecycleV176(world, frame = null) {
  const state = ensureState(world);
  const boat = currentHeavyBoat(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const committed = Boolean(world.freeCombatAiV175?.repairCommitted)
    && heavy?.repairSystem === "turret"
    && Number(boat?.turretHealth) <= 0;
  const encounterId = String(heavy?.encounterId ?? world.freeThreatDirector?.encounterId ?? "active");
  const key = `${encounterId}:turret`;
  let resetAfterEvents = false;
  let sawSafeAnnouncement = false;

  world.events = values(world.events).filter((event, index) => {
    if (!eventIsFresh(event, index, frame)) return true;
    if (actualRepairAbort(event) || REPAIR_COMPLETE_TYPES.has(event?.type)) {
      state.repairAnnouncementKey = null;
      state.repairAnchor = null;
      resetAfterEvents = true;
      return true;
    }
    if (event?.type !== "heavy-turret-repair-safe-v172") return true;
    sawSafeAnnouncement = true;
    return false;
  });

  if (!boat || !heavy || heavy.repairSystem !== "turret" || Number(boat.turretHealth) > 0) {
    state.repairAnnouncementKey = null;
    state.repairAnchor = null;
    return false;
  }

  const nearest = nearestLivingPlayerDistance(world, boat);
  if (!committed || resetAfterEvents || nearest < REPAIR_ABORT_CLEARANCE) {
    state.repairAnnouncementKey = null;
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

  if (sawSafeAnnouncement && state.repairAnnouncementKey !== key) {
    state.repairAnnouncementKey = key;
    world.events.push({
      type: "heavy-turret-repair-safe-v172",
      text: `Тяжёлый катер разорвал дистанцию до ${Math.round(nearest)} метров, остановился и начал ремонт оружейной установки.`,
      targets: [0, 1],
      at: world.time,
      operationEvent: true,
      system: "turret",
      clearance: REPAIR_START_CLEARANCE,
      nearest,
      destination: world.freeCombatAiV172?.stableRepairDestination
        ? {...world.freeCombatAiV172.stableRepairDestination}
        : null,
      x: boat.x,
      y: boat.y,
      normalizedV176: true,
    });
  }
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
    heavyReference: boat,
    heavyEncounterIds: knownHeavyEncounterIds(world),
  };
}

function staleAcrossEncounterBoundary(world, frame) {
  const boat = currentHeavyBoat(world);
  if (!frame?.heavyReference || boat !== frame.heavyReference) return false;
  const currentEncounterId = directorEncounterId(world);
  return frame.directorEncounterId !== currentEncounterId;
}

export function prepareCombatAiV176Overlay(world, helpers = {}) {
  const state = ensureState(world);
  synchronizeEncounterState(world, state);
  state.frame = frameSnapshot(world);
  retireStaleHeavyV176(world, "pre-step-stale-encounter");
  applyCombatAiModelV175(world, 0, helpers);
  return state;
}

export function finishCombatAiV176Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  const frame = state.frame || frameSnapshot(world);
  synchronizeEncounterState(world, state);

  if (staleAcrossEncounterBoundary(world, frame)) {
    retireStaleHeavyV176(world, "encounter-changed-during-step", true);
  } else {
    retireStaleHeavyV176(world, "post-step-stale-encounter");
  }
  rollbackPrematureThreatPhasesV176(world, frame);

  applyCombatAiModelV175(world, Math.max(0, Number(dt) || 0), helpers);
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

export {ADOPTION_LOOKAHEAD_SECONDS, REPAIR_START_CLEARANCE, REPAIR_ABORT_CLEARANCE};
