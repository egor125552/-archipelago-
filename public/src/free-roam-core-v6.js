"use strict";

import * as base from "./free-roam-core-v5.js?v=38";
import {
  activityStatus,
  dropCarriedCrate,
  ensureActivities,
  finishActivityFrame,
  handleActivityAction,
  setPresence,
  spawnRareCrate,
  storeActivityInput,
  updateActivities,
} from "./free-roam-activities.js?v=43";
// free-roam-combat.js?v=34 remains the stable combat base behind the 1.1 pistol layer.
import {applyCombatDamage, combatStatus, ensureCombat, updateCombat} from "./free-roam-combat-v2.js?v=4";
import {ensureMarauder, releaseStolenCargo, updateMarauder} from "./free-roam-marauder.js?v=33";
import {ensureFreeScenario, scenarioStatus, updateFreeScenario} from "./free-roam-scenario.js?v=44";
import {suppressIncapacitatedMovement, updatePhysicalActors} from "./free-roam-physical-actors.js?v=38";
import {handleAssistedBoarding} from "./free-roam-boarding-assist.js?v=29";
import {ensurePursuerSquad, updatePursuerSquad} from "./free-roam-pursuer-squad.js?v=33";
import {ensureHostileGunners, updateHostileGunners} from "./free-roam-hostile-gunners.js?v=32";
import {ensureEnemyBoats, updateEnemyBoats} from "./free-roam-enemy-boats.js?v=3";
import {ensureHostileActors, releaseCrewFromBoat, updateHostileActors} from "./free-roam-hostile-actors.js?v=2";
import {ensureThreatDirector, notifyThreatBoatDestroyed, threatLevel} from "./free-roam-threat-director.js?v=3";
import {ensureHeavyPursuer, updateHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=3";
import {retireClaimedKnifeCrates} from "./free-roam-unique-weapons.js?v=1";
import {finishThreatIntelligence, prepareThreatIntelligence} from "./free-roam-threat-intelligence.js?v=1";
import {suppressGameplayWhileShopping, updateMerchantShop} from "./free-roam-shop.js?v=3";
import {
  contractStatus,
  ensureContracts,
  suppressGameplayWhileContractBoard,
  updateContracts,
} from "./free-roam-contracts.js?v=3";

export const WORLD = Object.freeze({...base.WORLD});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const SALVAGE_START_RANGE = 4.8;
const SALVAGE_BOAT_BLOCK_RANGE = 12;
const SALVAGE_PAUSE_RANGE = 6.2;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureSalvageWork(world) {
  world.freeSalvageWork ||= {
    workers: Array.from({length: world.players?.length || 2}, () => null),
    deniedAt: Array.from({length: world.players?.length || 2}, () => -999),
    quarterByCrate: {},
  };
  const state = world.freeSalvageWork;
  state.workers ||= [];
  state.deniedAt ||= [];
  state.quarterByCrate ||= {};
  while (state.workers.length < world.players.length) state.workers.push(null);
  while (state.deniedAt.length < world.players.length) state.deniedAt.push(-999);
  return state;
}

function ensureBoatUpgrades(boat) {
  if (!boat) return;
  if (!Number.isInteger(boat.hullUpgradeLevel)) boat.hullUpgradeLevel = 0;
  if (!Number.isInteger(boat.pumpUpgradeLevel)) boat.pumpUpgradeLevel = 0;
  if (!Number.isInteger(boat.engineUpgradeLevel)) boat.engineUpgradeLevel = 0;
  if (!Number.isInteger(boat.sealUpgradeLevel)) boat.sealUpgradeLevel = 0;
  boat.collisionDamageMultiplier = clamp(Number(boat.collisionDamageMultiplier) || (1 - boat.hullUpgradeLevel * 0.14), 0.55, 1);
  boat.collisionLeakMultiplier = clamp(Number(boat.collisionLeakMultiplier) || (1 - boat.sealUpgradeLevel * 0.14), 0.55, 1);
  if (boat.pumpUpgradeLevel > 0) {
    boat.cargoPumpBonus = Math.max(Number(boat.cargoPumpBonus) || 0, boat.pumpUpgradeLevel * 2.5);
  }
}

function ensureState(world) {
  if (!world) return world;
  world.version = 6;
  ensureActivities(world);
  ensureCombat(world);
  ensureMarauder(world);
  ensurePursuerSquad(world);
  ensureHostileGunners(world);
  ensureEnemyBoats(world);
  ensureHostileActors(world);
  ensureThreatDirector(world);
  ensureHeavyPursuer(world);
  ensureFreeScenario(world);
  ensureContracts(world);
  ensureSalvageWork(world);
  for (const boat of world.boats || []) ensureBoatUpgrades(boat);
  retireClaimedKnifeCrates(world);
  return world;
}

function activeSalvageCrate(world) {
  const active = world.freeContracts?.activeContract;
  if (!active || active.category !== "salvage" || !active.crateId) return null;
  const crate = world.freeActivities?.crates?.find(candidate => candidate.id === active.crateId);
  return crate?.state === "world" && !crate.extracted ? crate : null;
}

function playerPoint(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
  return player;
}

function exitBoatIntoWater(world, playerIndex, boat, text = "Ты спрыгнул в воду.") {
  const player = world.players[playerIndex];
  if (!player || !boat || boat.sunk) return false;
  boat.driver = null;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.speed = 0;
  player.activeBoat = null;
  player.mode = "swim";
  player.x = boat.x;
  player.y = clamp(boat.y + 8, 5, WORLD.height - 5);
  player.heading = boat.heading;
  emit(world, "exit", text, [playerIndex], {sourcePlayer: playerIndex, x: player.x, y: player.y});
  return true;
}

function actionIsRising(world, playerIndex, nextInput) {
  return Boolean(nextInput?.action && !world.inputs?.[playerIndex]?.action && !world.operationInputs?.[playerIndex]?.action);
}

function nearShoreLanding(boat) {
  return Boolean(
    boat
    && boat.y <= WORLD.shoreY + 18
    && boat.x >= WORLD.shoreAccessMinX
    && boat.x <= WORLD.shoreAccessMaxX
  );
}

function nearbyWorldCargo(world, point, maximum = 12) {
  return (world.freeActivities?.crates || []).some(crate => crate.state === "world" && distance(crate, point) <= maximum);
}

function nearbyOtherBoat(world, boat, maximum = 24) {
  return (world.boats || []).some(candidate => candidate && candidate.id !== boat.id && distance(candidate, boat) <= maximum);
}

function startAccessibleSalvage(world, playerIndex, crate) {
  const state = ensureSalvageWork(world);
  const player = world.players[playerIndex];
  if (!["foot", "swim"].includes(player?.mode)) return false;
  if (distance(player, crate) > SALVAGE_START_RANGE) return false;
  const current = state.workers[playerIndex];
  if (current?.crateId === crate.id) {
    emit(world, "salvage-extraction-status", `Демонтаж уже идёт: ${Math.round((Number(crate.extractionProgress) || 0) / Math.max(0.1, Number(crate.extractionSeconds) || 3) * 100)} процентов. Оставайся рядом.`, [playerIndex], {
      sourcePlayer: playerIndex,
      crateId: crate.id,
      x: crate.x,
      y: crate.y,
    });
    return true;
  }
  state.workers[playerIndex] = {crateId: crate.id, paused: false};
  state.quarterByCrate[crate.id] ??= Math.min(3, Math.floor((Number(crate.extractionProgress) || 0) / Math.max(0.1, Number(crate.extractionSeconds) || 3) * 4));
  world.freeContracts.activeContract.phase = "extract";
  emit(world, "salvage-extraction-start", `Демонтаж начат: ${crate.label}. Нажимать и удерживать больше не нужно; оставайся рядом.`, [playerIndex], {
    sourcePlayer: playerIndex,
    crateId: crate.id,
    x: crate.x,
    y: crate.y,
  });
  return true;
}

function interceptSalvageAction(world, playerIndex, nextInput) {
  if (!actionIsRising(world, playerIndex, nextInput)) return false;
  const crate = activeSalvageCrate(world);
  if (!crate) return false;
  const point = playerPoint(world, playerIndex);
  const player = world.players[playerIndex];
  const maximum = ["boat", "roof"].includes(player?.mode) ? SALVAGE_BOAT_BLOCK_RANGE : SALVAGE_START_RANGE;
  if (!point || distance(point, crate) > maximum) return false;
  if (player.mode === "boat") {
    const boat = world.boats?.[player.activeBoat];
    if (!boat) return false;
    if (world.tow?.towerBoat === boat.id || world.tow?.towedBoat === boat.id) {
      emit(world, "salvage-extraction-denied", "Сначала отцепи буксировочный трос, затем выходи к металлолому.", [playerIndex], {sourcePlayer: playerIndex, crateId: crate.id, x: crate.x, y: crate.y});
      return true;
    }
    if (Math.abs(Number(boat.speed) || 0) > 0.35) {
      emit(world, "salvage-extraction-denied", "Полностью останови лодку, затем снова нажми действие, чтобы спрыгнуть к металлолому.", [playerIndex], {sourcePlayer: playerIndex, crateId: crate.id, x: crate.x, y: crate.y});
      return true;
    }
    return exitBoatIntoWater(world, playerIndex, boat, "Ты спрыгнул в воду рядом с металлоломом. Подплыви к детали и нажми действие один раз.");
  }
  return startAccessibleSalvage(world, playerIndex, crate);
}

function interceptOpenWaterExit(world, playerIndex, nextInput) {
  if (!actionIsRising(world, playerIndex, nextInput)) return false;
  const player = world.players?.[playerIndex];
  if (player?.mode !== "boat") return false;
  const boat = world.boats?.[player.activeBoat];
  if (!boat || boat.sunk || nearShoreLanding(boat)) return false;
  if (world.tow?.towerBoat === boat.id || world.tow?.towedBoat === boat.id) return false;
  if (nearbyWorldCargo(world, boat) || nearbyOtherBoat(world, boat)) return false;
  if (Math.abs(Number(boat.speed) || 0) > 0.35) {
    emit(world, "action-denied", "Чтобы выйти в открытую воду, полностью останови лодку.", [playerIndex], {sourcePlayer: playerIndex, x: boat.x, y: boat.y});
    return true;
  }
  return exitBoatIntoWater(world, playerIndex, boat);
}

function updateAccessibleSalvage(world, dt) {
  const state = ensureSalvageWork(world);
  const active = world.freeContracts?.activeContract;
  const groups = new Map();

  for (let index = 0; index < state.workers.length; index += 1) {
    const work = state.workers[index];
    if (!work) continue;
    const crate = world.freeActivities?.crates?.find(candidate => candidate.id === work.crateId);
    const player = world.players[index];
    if (!active || active.category !== "salvage" || active.crateId !== work.crateId || !crate || crate.state !== "world" || crate.extracted || !player?.combat?.alive) {
      state.workers[index] = null;
      continue;
    }
    const movement = world.operationInputs?.[index] || world.inputs?.[index] || {};
    const moved = Boolean(movement.up || movement.down || movement.left || movement.right || movement.run);
    const validPosition = ["foot", "swim"].includes(player.mode) && distance(player, crate) <= SALVAGE_PAUSE_RANGE;
    if (!validPosition || moved) {
      if (!work.paused) {
        work.paused = true;
        emit(world, "salvage-extraction-paused", "Демонтаж поставлен на паузу. Вернись к детали и остановись рядом.", [index], {
          sourcePlayer: index,
          crateId: crate.id,
          x: crate.x,
          y: crate.y,
        });
      }
      continue;
    }
    if (work.paused) {
      work.paused = false;
      emit(world, "salvage-extraction-resumed", "", [index], {sourcePlayer: index, crateId: crate.id, x: crate.x, y: crate.y});
    }
    if (!groups.has(crate.id)) groups.set(crate.id, {crate, workers: []});
    groups.get(crate.id).workers.push(index);
  }

  for (const {crate, workers} of groups.values()) {
    if (!workers.length) continue;
    const duration = Math.max(1.5, Number(crate.extractionSeconds) || 3);
    const speed = 1 + Math.max(0, workers.length - 1) * 0.65;
    crate.extractionProgress = clamp((Number(crate.extractionProgress) || 0) + dt * speed, 0, duration);
    active.phase = "extract";
    const quarter = Math.min(4, Math.floor(crate.extractionProgress / duration * 4));
    const previousQuarter = Number(state.quarterByCrate[crate.id]) || 0;
    if (quarter > previousQuarter && quarter < 4) {
      state.quarterByCrate[crate.id] = quarter;
      emit(world, "salvage-extraction-progress", `Демонтаж ${quarter * 25} процентов.`, workers, {
        sourcePlayer: workers[0],
        crateId: crate.id,
        percent: quarter * 25,
        x: crate.x,
        y: crate.y,
      });
    }
    if (crate.extractionProgress + 0.001 < duration) continue;
    crate.extracted = true;
    crate.extractionProgress = duration;
    active.phase = "transport";
    delete state.quarterByCrate[crate.id];
    for (let workerIndex = 0; workerIndex < state.workers.length; workerIndex += 1) {
      if (state.workers[workerIndex]?.crateId === crate.id) state.workers[workerIndex] = null;
    }
    emit(world, "salvage-extracted", `${crate.label} полностью отделён. Теперь отдельным действием подними его или погрузи в лодку.`, workers, {
      sourcePlayer: workers[0],
      crateId: crate.id,
      x: crate.x,
      y: crate.y,
    });
  }
}

function applyPermanentBoatUpgrades(world, dt) {
  for (const boat of world.boats || []) {
    ensureBoatUpgrades(boat);
    const level = clamp(Number(boat.engineUpgradeLevel) || 0, 0, 3);
    if (!level || boat.sunk || boat.engineStalled || boat.emergencyActive || boat.throttle <= 0.05) continue;
    const loadFactor = 1 + (Number(boat.cargoWeight) || 0) * 0.035;
    const maximum = 21 * (1 + level * 0.12) / loadFactor;
    const gain = (0.8 + level * 0.55) * dt;
    boat.speed = clamp(boat.speed + Math.max(0, maximum - boat.speed) * gain, -maximum * 0.42, maximum);
  }
}

export function createFreeWorld() {
  return ensureState(base.createFreeWorld());
}

export function setPlayerPresence(world, playerIndex, present) {
  ensureState(world);
  setPresence(world, playerIndex, present);
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureState(world);
  const sanitized = {...(nextInput || {})};
  if (interceptSalvageAction(world, playerIndex, sanitized) || interceptOpenWaterExit(world, playerIndex, sanitized)) sanitized.action = false;
  storeActivityInput(world, playerIndex, sanitized);
  if (["objective", "merchant", "board"].includes(nextInput?.navigationTargetId)) {
    world.freeActivities.inputs[playerIndex].navigationTargetId = nextInput.navigationTargetId;
  }
  base.setPlayerInput(world, playerIndex, sanitized);
}

export const drainEvents = base.drainEvents;

function consumeActivityActions(world) {
  const state = world.freeActivities;
  state.consumedActions ||= Array.from({length: world.players.length}, () => false);
  while (state.consumedActions.length < world.players.length) state.consumedActions.push(false);
  for (let index = 0; index < world.players.length; index += 1) {
    const input = state.inputs[index] || {};
    const previous = state.previousInputs[index] || {};
    if (!input.action) {
      state.consumedActions[index] = false;
      continue;
    }
    if (state.consumedActions[index]) {
      if (world.inputs?.[index]) world.inputs[index].action = false;
      if (world.operationInputs?.[index]) world.operationInputs[index].action = false;
      continue;
    }
    if (previous.action) continue;
    const handled = handleActivityAction(world, index) || handleAssistedBoarding(world, index);
    if (handled) {
      state.consumedActions[index] = true;
      if (world.inputs?.[index]) world.inputs[index].action = false;
      if (world.operationInputs?.[index]) world.operationInputs[index].action = false;
    }
  }
}

function discardBlockedFootsteps(world, eventStart, physicalState) {
  for (let index = world.events.length - 1; index >= eventStart; index -= 1) {
    const event = world.events[index];
    if (!event || !["footstep", "swim-step"].includes(event.type)) continue;
    const sourcePlayer = Number(event.sourcePlayer ?? event.targets?.[0]);
    if (physicalState?.boatBlocked?.[sourcePlayer]) world.events.splice(index, 1);
  }
}

export function stepFreeWorld(world, dt) {
  ensureState(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  const eventStart = world.events?.length || 0;
  updateMerchantShop(world);
  updateContracts(world, safeDt);
  updateAccessibleSalvage(world, safeDt);
  suppressGameplayWhileShopping(world);
  suppressGameplayWhileContractBoard(world);
  consumeActivityActions(world);
  suppressGameplayWhileShopping(world);
  suppressGameplayWhileContractBoard(world);
  const restoreMovement = suppressIncapacitatedMovement(world);
  base.stepFreeWorld(world, safeDt);
  restoreMovement();
  applyPermanentBoatUpgrades(world, safeDt);
  const combatHelpers = {
    dropCarriedCrate,
    releaseStolenCargo,
    spawnRareCrate,
    onEnemyBoatDestroyed(targetWorld, boat, sourcePlayer) {
      releaseCrewFromBoat(targetWorld, boat);
      notifyThreatBoatDestroyed(targetWorld, boat, sourcePlayer);
    },
  };
  updateCombat(world, safeDt, combatHelpers);
  const threatIntelligence = prepareThreatIntelligence(world);
  updateMarauder(world, safeDt, {spawnRareCrate, onEnemyBoatDestroyed: combatHelpers.onEnemyBoatDestroyed});
  if (threatIntelligence.hasLivingTargets) updatePursuerSquad(world, safeDt, {
    spawnRareCrate,
    onEnemyBoatDestroyed: combatHelpers.onEnemyBoatDestroyed,
    damagePlayer(targetWorld, targetIndex, amount, details) {
      return applyCombatDamage(targetWorld, targetIndex, amount, -1, details, combatHelpers);
    },
  });
  const enemyDamageHelpers = {
    damagePlayer(targetWorld, targetIndex, amount, details) {
      return applyCombatDamage(targetWorld, targetIndex, amount, -1, details, combatHelpers);
    },
    onEnemyBoatDestroyed: combatHelpers.onEnemyBoatDestroyed,
  };
  if (threatIntelligence.hasLivingTargets) {
    if (threatLevel(world) < 3) updateHostileGunners(world, safeDt, enemyDamageHelpers);
    updateEnemyBoats(world, safeDt, enemyDamageHelpers);
    updateHeavyPursuer(world, safeDt, enemyDamageHelpers);
    updateHostileActors(world, safeDt, enemyDamageHelpers);
  }
  finishThreatIntelligence(world, threatIntelligence, safeDt);
  const physicalState = updatePhysicalActors(world);
  discardBlockedFootsteps(world, eventStart, physicalState);
  updateActivities(world, safeDt);
  retireClaimedKnifeCrates(world);
  updateFreeScenario(world, safeDt);
  finishActivityFrame(world);
  return world;
}

export function playerStatus(world, playerIndex) {
  ensureState(world);
  return [
    base.playerStatus(world, playerIndex),
    scenarioStatus(world, playerIndex),
    combatStatus(world, playerIndex),
    activityStatus(world, playerIndex),
    contractStatus(world, playerIndex),
  ].filter(Boolean).join(" ");
}

export function snapshotWorld(world) {
  ensureState(world);
  return base.snapshotWorld(world);
}
