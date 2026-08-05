"use strict";

import {activatePursuerSquad, activePursuers, assignedPursuerForPlayer, isPursuerSquadDefeated} from "./free-roam-pursuer-squad.js?v=33";
import {activeHostileGunners} from "./free-roam-hostile-gunners.js?v=32";
import {activeEnemyBoats, ensureEnemyBoats, startEnemyBoats} from "./free-roam-enemy-boats.js?v=3";
import {activeHostileActors, ensureHostileActors, startHostileActors} from "./free-roam-hostile-actors.js?v=3";
import {activeHeavyPursuer, ensureHeavyPursuer, startHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=4";
import {activeEliteBoatBoss, eliteBossCompleted, ensureEliteBoatBoss, resetEliteBoatBoss, startEliteBoatBoss} from "./free-roam-elite-boat.js?v=1";
import {awardEncounter} from "./free-roam-encounter-loot.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
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

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function ensureThreatDirector(world) {
  world.freeThreatDirector ||= {
    active: false,
    level: 0,
    encounterId: 0,
    contractId: null,
    assignments: {},
    actorAssignments: {},
    retargetAt: 0,
    graceUntil: [0, 0],
    rewardIssued: false,
    cleared: false,
    startedAt: 0,
    heavyStarted: false,
    heavyStartsAt: 0,
    eliteBossStarted: false,
    lastPoint: {x: 210, y: 180},
  };
  const state = world.freeThreatDirector;
  state.assignments ||= {};
  state.actorAssignments ||= {};
  state.graceUntil ||= [0, 0];
  while (state.graceUntil.length < world.players.length) state.graceUntil.push(0);
  if (!Number.isFinite(state.encounterId)) state.encounterId = 0;
  if (!Number.isFinite(state.level)) state.level = 0;
  if (typeof state.heavyStarted !== "boolean") state.heavyStarted = Boolean(activeHeavyPursuer(world));
  if (!Number.isFinite(state.heavyStartsAt)) state.heavyStartsAt = 0;
  if (typeof state.eliteBossStarted !== "boolean") state.eliteBossStarted = Boolean(activeEliteBoatBoss(world) || eliteBossCompleted(world));
  ensureEliteBoatBoss(world);
  return state;
}

function presentPlayers(world) {
  return world.players.map((player, index) => ({player, index})).filter(({player, index}) => world.freeActivities?.presence?.[index] && player?.combat?.alive);
}

function contractCarrier(world) {
  const crateId = world.freeContracts?.activeContract?.crateId;
  if (!crateId) return null;
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    if (player?.combat?.carriedCrate === crateId) return index;
    const boat = Number.isInteger(player?.activeBoat) ? world.boats[player.activeBoat] : world.boats.find(candidate => candidate.owner === index);
    if (boat?.cargo?.includes(crateId)) return index;
  }
  return null;
}

function allThreatBoats(world) {
  const boats = [...activePursuers(world), ...activeEnemyBoats(world)];
  const heavy = activeHeavyPursuer(world);
  if (heavy) boats.push(heavy);
  const elite = activeEliteBoatBoss(world)?.boat;
  if (elite?.alive) boats.push(elite);
  return boats;
}

function balanceAssignments(world, state) {
  const players = presentPlayers(world).map(item => item.index);
  if (!players.length) { state.assignments = {}; return; }
  const carrier = contractCarrier(world);
  const counts = Object.fromEntries(players.map(index => [index, 0]));
  const next = {};
  const boats = allThreatBoats(world);
  const maximumPerPlayer = players.length > 1 ? Math.max(1, Math.ceil(boats.length * 0.65)) : boats.length;
  for (const boat of boats) {
    const previous = state.assignments[boat.id];
    if (players.includes(previous) && counts[previous] < maximumPerPlayer) {
      next[boat.id] = previous;
      counts[previous] += 1;
    }
  }
  for (const boat of boats) {
    if (Number.isInteger(next[boat.id])) continue;
    const choices = [...players].sort((left, right) => {
      const carrierBiasLeft = left === carrier ? -0.25 : 0;
      const carrierBiasRight = right === carrier ? -0.25 : 0;
      return (counts[left] + carrierBiasLeft) - (counts[right] + carrierBiasRight)
        || distance(boat, world.players[left]) - distance(boat, world.players[right]);
    });
    const selected = choices[0];
    next[boat.id] = selected;
    counts[selected] += 1;
  }
  state.assignments = next;
  const baseIds = new Set(activePursuers(world).map(boat => boat.id));
  if (world.freePursuerSquad) {
    world.freePursuerSquad.assignments = Object.fromEntries(
      Object.entries(next).filter(([boatId]) => baseIds.has(boatId)),
    );
  }
  for (const boat of boats) boat.targetPlayer = next[boat.id] ?? players[0];
  state.retargetAt = world.time + 10;
}

function anchorForContract(world) {
  const carrier = contractCarrier(world);
  const player = Number.isInteger(carrier) ? world.players[carrier] : world.players[0];
  const actor = ["boat", "roof"].includes(player?.mode) ? world.boats[player.activeBoat] || player : player;
  return actor || {x: 210, y: 180};
}

function activateBasePursuers(world, anchor, escortCount = 2) {
  const pursuer = world.freeActivities?.marauder;
  if (!pursuer) return;
  pursuer.x = clamp((anchor?.x || 210) + 105, 18, 402);
  pursuer.y = clamp((anchor?.y || 180) + 70, 92, 302);
  pursuer.heading = 315;
  pursuer.speed = 0;
  pursuer.hull = 72;
  pursuer.active = true;
  pursuer.destroyed = false;
  pursuer.ramCooldown = 4;
  pursuer.recoveryRemaining = 0;
  pursuer.respawnAt = 0;
  const squad = world.freePursuerSquad;
  if (squad) {
    squad.activated = false;
    squad.assignments = {};
    squad.escorts = [];
    squad.projectiles = [];
  }
  const legacyGunners = world.freeHostileGunners;
  if (legacyGunners) {
    legacyGunners.gunners = [];
    legacyGunners.projectiles = [];
    legacyGunners.eliminatedPursuers = [];
  }
  activatePursuerSquad(world);
  if (world.freePursuerSquad) {
    world.freePursuerSquad.escorts = world.freePursuerSquad.escorts.slice(0, clamp(Math.floor(escortCount), 0, 2));
  }
}

function projectileSourceIds(projectile) {
  return [
    projectile?.sourceId,
    projectile?.sourceBoatId,
    projectile?.sourcePursuerId,
    projectile?.sourceActorId,
    projectile?.boatId,
    projectile?.actorId,
    projectile?.ownerId,
    projectile?.shooterId,
    projectile?.launcherId,
  ].filter(value => value !== null && value !== undefined && String(value) !== "").map(String);
}

function clearHeavyTargetReferences(world) {
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

export function resetHeavyThreatState(world) {
  const state = ensureThreatDirector(world);
  const heavyState = ensureHeavyPursuer(world);
  const oldBoat = heavyState.boat;
  if (oldBoat) {
    oldBoat.active = false;
    oldBoat.speed = 0;
  }

  const removedActorIds = new Set(values(world.freeHostileActors?.actors)
    .filter(actor => String(actor?.boatId || "") === "heavy-pursuer")
    .map(actor => String(actor.id)));

  heavyState.active = false;
  heavyState.encounterId = 0;
  heavyState.boat = null;
  heavyState.projectiles = [];
  delete heavyState.v176ContractId;

  if (world.freeHostileActors?.actors) {
    world.freeHostileActors.actors = filterCollection(
      world.freeHostileActors.actors,
      actor => String(actor?.boatId || "") !== "heavy-pursuer",
    );
  }
  if (world.freeHostileActors?.projectiles && removedActorIds.size) {
    world.freeHostileActors.projectiles = filterCollection(
      world.freeHostileActors.projectiles,
      projectile => !projectileSourceIds(projectile).some(id => removedActorIds.has(id)),
    );
  }

  if (world.freeCombatAiV164) {
    world.freeCombatAiV164.heavy = null;
    world.freeCombatAiV164.heavyEncounterId = null;
    world.freeCombatAiV164.frame = null;
  }
  if (world.freeCombatAiV172) {
    world.freeCombatAiV172.repairEncounterId = null;
    world.freeCombatAiV172.stableRepairDestination = null;
    world.freeCombatAiV172.frame = null;
    world.freeCombatAiV172.targetLocks = {};
  }
  if (world.freeCombatAiV174) {
    world.freeCombatAiV174.adoptedEncounterId = null;
    world.freeCombatAiV174.frame = null;
  }
  if (world.freeCombatAiV175) {
    world.freeCombatAiV175.repairCommitted = false;
    world.freeCombatAiV175.repairAnnouncementActive = false;
    world.freeCombatAiV175.frame = null;
  }
  if (world.freeCombatAiV176) {
    world.freeCombatAiV176.heavyContractId = null;
    world.freeCombatAiV176.repairAnnouncementKey = null;
    world.freeCombatAiV176.repairAnchor = null;
    world.freeCombatAiV176.frame = null;
  }

  clearHeavyTargetReferences(world);
  delete state.assignments["heavy-pursuer"];
  for (const actorId of removedActorIds) delete state.actorAssignments[actorId];
  return Boolean(oldBoat || removedActorIds.size);
}

export function startThreatEncounter(world, requestedLevel, contractId = null) {
  const state = ensureThreatDirector(world);
  resetHeavyThreatState(world);
  resetEliteBoatBoss(world, "new-threat");
  const level = clamp(Math.floor(Number(requestedLevel) || 0), 0, 5);
  state.encounterId += 1;
  state.contractId = contractId;
  state.level = level;
  state.rewardIssued = false;
  state.cleared = false;
  state.startedAt = world.time;
  state.lastPoint = anchorForContract(world);
  state.assignments = {};
  state.actorAssignments = {};
  state.graceUntil = world.players.map(() => 0);
  state.heavyStarted = false;
  state.heavyStartsAt = 0;
  state.eliteBossStarted = false;
  if (level <= 1) {
    state.active = false;
    startEnemyBoats(world, level, state.lastPoint);
    emit(world, "contract-threat-observed", "Угроза один из пяти. Разведывательный катер ведёт наблюдение и передаёт координаты, но в бой не вступает.", [0, 1], {contractId, level});
    return state;
  }
  state.active = true;
  if (level >= 3 && world.freeHostileGunners) {
    world.freeHostileGunners.gunners = [];
    world.freeHostileGunners.projectiles = [];
  }
  const escortCount = level === 2 ? 0 : level === 3 ? 1 : 2;
  activateBasePursuers(world, state.lastPoint, escortCount);
  startEnemyBoats(world, level, state.lastPoint);
  balanceAssignments(world, state);
  if (level >= 3) startHostileActors(world, level, state.encounterId, state.assignments);
  if (level >= 5) state.heavyStartsAt = world.time + 7;
  if (world.freeContracts) {
    world.freeContracts.encounterActive = true;
    world.freeContracts.encounterLevel = level;
    world.freeContracts.encounterDefeated = false;
  }
  const text = level === 2
    ? "Угроза два из пяти: один лёгкий катер начал преследование."
    : level === 3
      ? "Угроза три из пяти: вооружённая погоня. Два преследователя и катер-перехватчик заходят с разных направлений."
      : level === 4
        ? "Угроза четыре из пяти: засада. Таранщики, стрелковый катер и высадка перекрывают отход."
        : "Угроза пять из пяти: началась первая волна. Сначала войдёт тяжёлый катер; после его уничтожения появится элитный катер-босс с тремя слоями брони.";
  emit(world, "contract-threat-start", `${text} Во время боя доступны только боевые цели.`, [0, 1], {contractId, level, x: state.lastPoint.x, y: state.lastPoint.y});
  return state;
}

export function cancelThreatEncounter(world, reason = "cancelled") {
  const state = ensureThreatDirector(world);
  resetHeavyThreatState(world);
  resetEliteBoatBoss(world, reason);
  state.active = false;
  state.cleared = false;
  state.assignments = {};
  state.actorAssignments = {};
  state.contractId = null;
  state.heavyStarted = false;
  state.heavyStartsAt = 0;
  state.eliteBossStarted = false;
  const marauder = world.freeActivities?.marauder;
  if (marauder) { marauder.active = false; marauder.speed = 0; }
  if (world.freePursuerSquad) {
    world.freePursuerSquad.activated = false;
    world.freePursuerSquad.assignments = {};
    world.freePursuerSquad.escorts = [];
    world.freePursuerSquad.projectiles = [];
  }
  if (world.freeEnemyBoats) {
    world.freeEnemyBoats.active = false;
    world.freeEnemyBoats.boats = [];
    world.freeEnemyBoats.projectiles = [];
  }
  if (world.freeHostileActors) {
    world.freeHostileActors.active = false;
    world.freeHostileActors.actors = [];
    world.freeHostileActors.projectiles = [];
  }
  if (world.freeHostileGunners) {
    world.freeHostileGunners.gunners = [];
    world.freeHostileGunners.projectiles = [];
  }
  if (world.freeContracts) {
    world.freeContracts.encounterActive = false;
    world.freeContracts.encounterLevel = 0;
  }
  return reason;
}

export function threatEncounterActive(world) {
  return Boolean(ensureThreatDirector(world).active);
}

export function threatLevel(world) {
  return ensureThreatDirector(world).level;
}

export function assignedThreatTarget(world, playerIndex) {
  const state = ensureThreatDirector(world);
  const assignedBase = assignedPursuerForPlayer(world, playerIndex);
  if (assignedBase) return assignedBase;
  const id = Object.entries(state.assignments).find(([, target]) => target === playerIndex)?.[0];
  return allThreatBoats(world).find(boat => boat.id === id) || allThreatBoats(world)[0] || null;
}

export function notifyThreatBoatDestroyed(world, boat, sourcePlayer = -1) {
  const state = ensureThreatDirector(world);
  const targetPlayer = state.assignments[boat.id];
  if (Number.isInteger(targetPlayer)) state.graceUntil[targetPlayer] = Math.max(state.graceUntil[targetPlayer], world.time + 3);
  delete state.assignments[boat.id];
  state.lastPoint = {x: boat.x, y: boat.y};
  if (state.active && state.level >= 5 && String(boat?.id) === "heavy-pursuer" && !state.eliteBossStarted) {
    const target = contractCarrier(world) ?? presentPlayers(world)[0]?.index ?? 0;
    const boss = startEliteBoatBoss(world, state.encounterId, state.lastPoint, target);
    state.eliteBossStarted = true;
    state.assignments[boss.boat.id] = target;
    emit(world, "contract-threat-phase", "Третья фаза. Тяжёлый катер уничтожен; в бухту входит отдельный элитный катер-босс с тремя слоями брони.", [0, 1], {
      level: state.level, phase: 3, x: boss.boat.x, y: boss.boat.y, eliteBossEncounterId: boss.encounterId,
    });
    return;
  }
  if (sourcePlayer >= 0) emit(world, "threat-breathing-room", "Твой преследователь уничтожен. У тебя три секунды передышки, прежде чем резерв перераспределится.", [sourcePlayer], {sourcePlayer, x: boat.x, y: boat.y});
}

function combatStillActive(world, state) {
  if (!isPursuerSquadDefeated(world)) return true;
  if (activeEnemyBoats(world).length) return true;
  if (state.level === 2 && activeHostileGunners(world).length) return true;
  if (state.level >= 3 && activeHostileActors(world).length) return true;
  if (state.level >= 5 && (!state.heavyStarted || activeHeavyPursuer(world))) return true;
  if (state.level >= 5 && (!state.eliteBossStarted || activeEliteBoatBoss(world))) return true;
  if (state.level >= 5 && state.eliteBossStarted && !eliteBossCompleted(world)) return true;
  return false;
}

export function updateThreatDirector(world) {
  const state = ensureThreatDirector(world);
  ensureEnemyBoats(world);
  ensureHostileActors(world);
  ensureHeavyPursuer(world);
  if (!state.active) return state;
  if (state.level >= 5 && !state.heavyStarted && world.time >= state.heavyStartsAt) {
    const targetPlayer = contractCarrier(world) ?? presentPlayers(world)[0]?.index ?? 0;
    const heavy = startHeavyPursuer(world, state.encounterId, anchorForContract(world), targetPlayer);
    state.heavyStarted = true;
    state.lastPoint = {x: heavy.x, y: heavy.y};
    balanceAssignments(world, state);
    emit(world, "contract-threat-phase", "Вторая фаза. Тяжёлый катер вошёл в бухту. Уничтожь его, чтобы вызвать элитный катер-босс.", [0, 1], {level: state.level, phase: 2, x: heavy.x, y: heavy.y});
  }
  if (world.time >= state.retargetAt) balanceAssignments(world, state);
  for (const boat of allThreatBoats(world)) {
    const target = state.assignments[boat.id];
    if (Number.isInteger(target) && world.time < state.graceUntil[target]) {
      const alternatives = presentPlayers(world).map(item => item.index).filter(index => index !== target && world.time >= state.graceUntil[index]);
      if (alternatives.length) {
        boat.targetPlayer = alternatives[0];
        state.assignments[boat.id] = alternatives[0];
      } else boat.speed = Math.min(boat.speed, 5);
    }
  }
  if (combatStillActive(world, state)) return state;
  state.active = false;
  state.cleared = true;
  if (world.freeContracts) {
    world.freeContracts.encounterActive = false;
    world.freeContracts.encounterDefeated = true;
    if (world.freeContracts.activeContract) world.freeContracts.activeContract.phase = "return";
  }
  awardEncounter(world, state.level, state.lastPoint);
  if (state.level >= 5 && world.freeEliteBoatBoss) world.freeEliteBoatBoss.rewardReady = false;
  emit(world, "contract-threat-cleared", state.level >= 5
    ? "Элитный катер и его командир уничтожены. Текущая угроза завершена; этот босс пока последний в этой угрозе, но не объявлен окончательным боссом всей игры."
    : "Боевая угроза устранена. Навигация к заказу восстановлена. Добыча и контрактный груз остаются в мире.", [0, 1], {level: state.level});
  return state;
}
