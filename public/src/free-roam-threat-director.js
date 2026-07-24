"use strict";

import {activatePursuerSquad, activePursuers, assignedPursuerForPlayer, isPursuerSquadDefeated} from "./free-roam-pursuer-squad.js?v=33";
import {activeHostileGunners} from "./free-roam-hostile-gunners.js?v=32";
import {activeEnemyBoats, ensureEnemyBoats, startEnemyBoats} from "./free-roam-enemy-boats.js?v=1";
import {activeHostileActors, ensureHostileActors, startHostileActors} from "./free-roam-hostile-actors.js?v=1";
import {awardEncounter} from "./free-roam-encounter-loot.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

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
    lastPoint: {x: 210, y: 180},
  };
  const state = world.freeThreatDirector;
  state.assignments ||= {};
  state.actorAssignments ||= {};
  state.graceUntil ||= [0, 0];
  while (state.graceUntil.length < world.players.length) state.graceUntil.push(0);
  if (!Number.isFinite(state.encounterId)) state.encounterId = 0;
  if (!Number.isFinite(state.level)) state.level = 0;
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
  return [...activePursuers(world), ...activeEnemyBoats(world)];
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

function activateBasePursuers(world, anchor) {
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
}

export function startThreatEncounter(world, requestedLevel, contractId = null) {
  const state = ensureThreatDirector(world);
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
  if (level <= 1) {
    state.active = false;
    emit(world, "contract-threat-observed", "Угроза один из пяти. За грузом наблюдают, но прямой атаки пока нет.", [0, 1], {contractId, level});
    return state;
  }
  state.active = true;
  if (level >= 3 && world.freeHostileGunners) {
    world.freeHostileGunners.gunners = [];
    world.freeHostileGunners.projectiles = [];
  }
  activateBasePursuers(world, state.lastPoint);
  startEnemyBoats(world, level, state.lastPoint);
  balanceAssignments(world, state);
  if (level >= 3) startHostileActors(world, level, state.encounterId, state.assignments);
  if (world.freeContracts) {
    world.freeContracts.encounterActive = true;
    world.freeContracts.encounterLevel = level;
    world.freeContracts.encounterDefeated = false;
  }
  const text = level === 2
    ? "Угроза два из пяти: в бухту вошли катера-преследователи."
    : level === 3
      ? "Угроза три из пяти: усиленная группа смешивает катера, пистолеты и автоматы."
      : level === 4
        ? "Угроза четыре из пяти: ударная группа распределяется между двумя игроками."
        : "Угроза пять из пяти: приближается тяжёлый катер.";
  emit(world, "contract-threat-start", `${text} Во время боя доступны только боевые цели.`, [0, 1], {contractId, level, x: state.lastPoint.x, y: state.lastPoint.y});
  return state;
}

export function cancelThreatEncounter(world, reason = "cancelled") {
  const state = ensureThreatDirector(world);
  state.active = false;
  state.cleared = false;
  state.assignments = {};
  state.actorAssignments = {};
  state.contractId = null;
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
  if (sourcePlayer >= 0) emit(world, "threat-breathing-room", "Твой преследователь уничтожен. У тебя три секунды передышки, прежде чем резерв перераспределится.", [sourcePlayer], {sourcePlayer, x: boat.x, y: boat.y});
}

function combatStillActive(world, level) {
  if (!isPursuerSquadDefeated(world)) return true;
  if (activeEnemyBoats(world).length) return true;
  if (level === 2 && activeHostileGunners(world).length) return true;
  if (level >= 3 && activeHostileActors(world).length) return true;
  return false;
}

export function updateThreatDirector(world) {
  const state = ensureThreatDirector(world);
  ensureEnemyBoats(world);
  ensureHostileActors(world);
  if (!state.active) return state;
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
  if (combatStillActive(world, state.level)) return state;
  state.active = false;
  state.cleared = true;
  if (world.freeContracts) {
    world.freeContracts.encounterActive = false;
    world.freeContracts.encounterDefeated = true;
    if (world.freeContracts.activeContract) world.freeContracts.activeContract.phase = "return";
  }
  awardEncounter(world, state.level, state.lastPoint);
  emit(world, "contract-threat-cleared", "Боевая угроза устранена. Навигация к заказу восстановлена. Добыча и контрактный груз остаются в мире.", [0, 1], {level: state.level});
  return state;
}
