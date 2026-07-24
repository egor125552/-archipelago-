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
} from "./free-roam-activities.js?v=42";
// free-roam-combat.js?v=34 remains the stable combat base behind the 1.1 pistol layer.
import {applyCombatDamage, combatStatus, ensureCombat, updateCombat} from "./free-roam-combat-v2.js?v=3";
import {ensureMarauder, releaseStolenCargo, updateMarauder} from "./free-roam-marauder.js?v=33";
import {ensureFreeScenario, scenarioStatus, updateFreeScenario} from "./free-roam-scenario.js?v=43";
import {suppressIncapacitatedMovement, updatePhysicalActors} from "./free-roam-physical-actors.js?v=38";
import {handleAssistedBoarding} from "./free-roam-boarding-assist.js?v=29";
import {ensurePursuerSquad, updatePursuerSquad} from "./free-roam-pursuer-squad.js?v=33";
import {ensureHostileGunners, updateHostileGunners} from "./free-roam-hostile-gunners.js?v=32";
import {ensureEnemyBoats, updateEnemyBoats} from "./free-roam-enemy-boats.js?v=2";
import {ensureHostileActors, releaseCrewFromBoat, updateHostileActors} from "./free-roam-hostile-actors.js?v=2";
import {ensureThreatDirector, notifyThreatBoatDestroyed, threatLevel} from "./free-roam-threat-director.js?v=2";
import {ensureHeavyPursuer, updateHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=1";
import {retireClaimedKnifeCrates} from "./free-roam-unique-weapons.js?v=1";
import {suppressGameplayWhileShopping, updateMerchantShop} from "./free-roam-shop.js?v=1";
import {
  contractStatus,
  ensureContracts,
  suppressGameplayWhileContractBoard,
  updateContracts,
} from "./free-roam-contracts.js?v=2";

export const WORLD = Object.freeze({...base.WORLD});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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
  retireClaimedKnifeCrates(world);
  return world;
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
  storeActivityInput(world, playerIndex, nextInput);
  base.setPlayerInput(world, playerIndex, nextInput);
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
  suppressGameplayWhileShopping(world);
  suppressGameplayWhileContractBoard(world);
  consumeActivityActions(world);
  suppressGameplayWhileShopping(world);
  suppressGameplayWhileContractBoard(world);
  const restoreMovement = suppressIncapacitatedMovement(world);
  base.stepFreeWorld(world, safeDt);
  restoreMovement();
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
  updateMarauder(world, safeDt, {spawnRareCrate, onEnemyBoatDestroyed: combatHelpers.onEnemyBoatDestroyed});
  updatePursuerSquad(world, safeDt, {
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
  if (threatLevel(world) < 3) updateHostileGunners(world, safeDt, enemyDamageHelpers);
  updateEnemyBoats(world, safeDt, enemyDamageHelpers);
  updateHeavyPursuer(world, safeDt, enemyDamageHelpers);
  updateHostileActors(world, safeDt, enemyDamageHelpers);
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
