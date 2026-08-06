"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
import {
  ensureDualTurretBoat,
  playerDualTurret,
  prepareDualTurretBoatRoom,
} from "./free-roam-dual-turret-boat.js?v=3";
import {
  finishDualTurretWeaponStep,
  prepareDualTurretWeaponStep,
} from "./free-roam-dual-turret-weapons.js?v=3";
import {ensureDualTurretProjectileState} from "./free-roam-dual-turret-projectiles.js?v=3";
import {
  finishDualTurretPrototypeStep,
  prepareDualTurretPrototypeRoom,
  prepareDualTurretPrototypeStep,
} from "./free-roam-dual-turret-test-lifecycle.js?v=2";
import {
  ensureDualTurretPurchaseState,
  finishDualTurretPurchaseStep,
  prepareDualTurretPurchaseRoom,
  prepareDualTurretPurchaseStep,
} from "./free-roam-dual-turret-purchase.js?v=2";
import {
  capturePlayerBoatInput,
  finishPlayerBoatStep,
  preparePlayerBoatStep,
} from "./free-roam-player-boats.js?v=1";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom, prepareDualTurretPurchaseRoom, prepareDualTurretPrototypeRoom};
export const WORLD = base.WORLD;

export function createFreeWorld() {
  const world = base.createFreeWorld();
  ensureDualTurretBoat(world, {activate: true});
  prepareDualTurretPurchaseRoom(world);
  prepareDualTurretPrototypeRoom(world);
  ensureDualTurretProjectileState(world);
  return world;
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureDualTurretBoat(world, {activate: false});
  const sanitized = {...(nextInput || {})};
  if (capturePlayerBoatInput(world, playerIndex, sanitized)) sanitized.action = false;
  base.setPlayerInput(world, playerIndex, sanitized);
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureDualTurretBoat(world, {activate: false});
  ensureDualTurretPurchaseState(world);
  ensureDualTurretProjectileState(world);
  const eventStart = world.events?.length || 0;
  const prototypeContext = prepareDualTurretPrototypeStep(world);
  const purchaseContext = prepareDualTurretPurchaseStep(world);
  const playerBoatContext = preparePlayerBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  finishPlayerBoatStep(world, playerBoatContext, safeDt, eventStart);
  finishDualTurretPurchaseStep(purchaseContext);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  finishDualTurretPrototypeStep(world, prototypeContext, safeDt);
  return result;
}

export function playerStatus(world, playerIndex) {
  const inherited = base.playerStatus(world, playerIndex);
  const player = world?.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (boat?.boatType !== "dual-turret-patrol") return inherited;
  const turret = playerDualTurret(world, playerIndex);
  return `${inherited} Двухместный бронекатер: корпус ${Math.round(boat.structuralHull)} из ${Math.round(boat.maxStructuralHull)}, броня ${Math.round(boat.armor)} из ${Math.round(boat.armorMax)}. ${turret ? `${turret.label}: патронов ${turret.ammo}.` : "Установка не назначена."}`;
}
