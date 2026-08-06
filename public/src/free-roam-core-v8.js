"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
import {CONFIG} from "./game-core-v18.js?free=boat-physics";
import {
  dualTurretBoat,
  ensureDualTurretBoatState,
  finishDualTurretBoatStep,
  playerDualTurret,
  prepareDualTurretBoatRoom,
  prepareDualTurretBoatStep,
  prepareDualTurretInput,
} from "./free-roam-dual-turret-boat.js?v=4";
import {
  finishDualTurretWeaponStep,
  prepareDualTurretWeaponStep,
} from "./free-roam-dual-turret-weapons.js?v=5";
import {applyDualTurretSpeech} from "./free-roam-dual-turret-speech.js?v=1";
import {ensureDualTurretPhysicsProfile} from "./free-roam-dual-turret-physics.js?v=1";
import {
  applyBoatPhysicsProfiles,
  captureBoatPhysicsState,
} from "./free-roam-boat-physics.js?v=1";
import {
  activeBoatIds,
  attachBoatTransitionMetadata,
} from "./free-roam-boat-events.js?v=1";
import {isPlayerNearMerchant} from "./free-roam-shop.js?v=5";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom};
export const WORLD = base.WORLD;

function ensureController(world, options) {
  const state = ensureDualTurretBoatState(world, options);
  if (!world) return state;
  ensureDualTurretPhysicsProfile(world);
  delete world.freePlayerBoats;
  delete world.freeDualTurretPurchase;
  delete world.freeDualTurretPrototype;
  delete world.freeDualTurretWeapons;
  delete world.freeDualTurretProjectiles;
  return state;
}

export function merchantOwnsAction(world, playerIndex, nextInput) {
  return Boolean(nextInput?.action && isPlayerNearMerchant(world?.players?.[playerIndex]));
}

export function prepareFreeRoamPlayerInput(world, playerIndex, nextInput) {
  if (!merchantOwnsAction(world, playerIndex, nextInput)) {
    return prepareDualTurretInput(world, playerIndex, nextInput);
  }
  const held = world?.freeDualTurretBoat?.rawActionHeld;
  if (Array.isArray(held)) held[playerIndex] = Boolean(nextInput?.action);
  return {...(nextInput || {})};
}

export function createFreeWorld() {
  const world = base.createFreeWorld();
  ensureController(world, {activate: true});
  prepareDualTurretBoatRoom(world);
  ensureDualTurretPhysicsProfile(world);
  return world;
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureController(world, {activate: false});
  const eventStart = world.events?.length || 0;
  const previousBoatIds = activeBoatIds(world);
  base.setPlayerInput(world, playerIndex, prepareFreeRoamPlayerInput(world, playerIndex, nextInput));
  attachBoatTransitionMetadata(world, eventStart, previousBoatIds);
  applyDualTurretSpeech(world, eventStart);
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureController(world, {activate: false});
  const eventStart = world.events?.length || 0;
  const previousBoatIds = activeBoatIds(world);
  const previousPhysics = captureBoatPhysicsState(world);
  const boatContext = prepareDualTurretBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  applyBoatPhysicsProfiles(world, previousPhysics, safeDt, {tuning: CONFIG, eventStart});
  finishDualTurretBoatStep(world, boatContext, safeDt);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  attachBoatTransitionMetadata(world, eventStart, previousBoatIds);
  applyDualTurretSpeech(world, eventStart);
  return result;
}

export function playerStatus(world, playerIndex) {
  const inherited = base.playerStatus(world, playerIndex);
  const player = world?.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (boat !== dualTurretBoat(world)) return inherited;
  const turret = playerDualTurret(world, playerIndex);
  return `${inherited} Двухместный бронекатер: корпус ${Math.round(boat.hull)} из ${Math.round(boat.hullMax)}, броня ${Math.round(boat.armor)} из ${Math.round(boat.armorMax)}. ${turret ? `${turret.label}: патронов ${turret.ammo}.` : "Установка не назначена."}`;
}
