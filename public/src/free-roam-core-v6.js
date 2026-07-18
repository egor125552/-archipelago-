"use strict";

import * as base from "./free-roam-core-v5.js";
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
} from "./free-roam-activities.js";
import {combatStatus, ensureCombat, updateCombat} from "./free-roam-combat.js";
import {ensureMarauder, releaseStolenCargo, updateMarauder} from "./free-roam-marauder.js";
import {ensureFreeScenario, scenarioStatus, updateFreeScenario} from "./free-roam-scenario.js";
import {suppressIncapacitatedMovement, updatePhysicalActors} from "./free-roam-physical-actors.js";
import {handleAssistedBoarding} from "./free-roam-boarding-assist.js";

export const WORLD = Object.freeze({...base.WORLD});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ensureState(world) {
  if (!world) return world;
  world.version = 6;
  ensureActivities(world);
  ensureCombat(world);
  ensureMarauder(world);
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
  for (let index = 0; index < world.players.length; index += 1) {
    const input = state.inputs[index] || {};
    const previous = state.previousInputs[index] || {};
    if (!input.action || previous.action) continue;
    const handled = handleActivityAction(world, index) || handleAssistedBoarding(world, index);
    if (handled && world.inputs?.[index]) {
      world.inputs[index].action = false;
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
  updateCombat(world, safeDt, {dropCarriedCrate, releaseStolenCargo, spawnRareCrate});
  updateMarauder(world, safeDt, {spawnRareCrate});
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
