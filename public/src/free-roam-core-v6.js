"use strict";

import * as base from "./free-roam-core-v5.js?v=35";
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
} from "./free-roam-activities.js?v=35";
import {applyCombatDamage, combatStatus, ensureCombat, updateCombat} from "./free-roam-combat.js?v=32";
import {ensureMarauder, releaseStolenCargo, updateMarauder} from "./free-roam-marauder.js?v=32";
import {ensureFreeScenario, scenarioStatus, updateFreeScenario} from "./free-roam-scenario.js?v=35";
import {suppressIncapacitatedMovement, updatePhysicalActors} from "./free-roam-physical-actors.js?v=32";
import {handleAssistedBoarding} from "./free-roam-boarding-assist.js?v=29";
import {ensurePursuerSquad, updatePursuerSquad} from "./free-roam-pursuer-squad.js?v=32";
import {ensureHostileGunners, updateHostileGunners} from "./free-roam-hostile-gunners.js?v=32";

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
  ensureFreeScenario(world);
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

export function stepFreeWorld(world, dt) {
  ensureState(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  consumeActivityActions(world);
  const restoreMovement = suppressIncapacitatedMovement(world);
  base.stepFreeWorld(world, safeDt);
  restoreMovement();
  const combatHelpers = {dropCarriedCrate, releaseStolenCargo, spawnRareCrate};
  updateCombat(world, safeDt, combatHelpers);
  updateMarauder(world, safeDt, {spawnRareCrate});
  updatePursuerSquad(world, safeDt, {
    spawnRareCrate,
    damagePlayer(targetWorld, targetIndex, amount, details) {
      return applyCombatDamage(targetWorld, targetIndex, amount, -1, details, combatHelpers);
    },
  });
  updateHostileGunners(world, safeDt, {
    damagePlayer(targetWorld, targetIndex, amount, details) {
      return applyCombatDamage(targetWorld, targetIndex, amount, -1, details, combatHelpers);
    },
  });
  updatePhysicalActors(world);
  updateActivities(world, safeDt);
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
  ].filter(Boolean).join(" ");
}

export function snapshotWorld(world) {
  ensureState(world);
  return base.snapshotWorld(world);
}
