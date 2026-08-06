"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
import {
  ensureDualTurretBoat,
  finishDualTurretBoatStep,
  playerDualTurret,
  prepareDualTurretBoatRoom,
  prepareDualTurretBoatStep,
} from "./free-roam-dual-turret-boat.js";
import {
  finishDualTurretWeaponStep,
  prepareDualTurretWeaponStep,
} from "./free-roam-dual-turret-weapons.js";
import {
  ensureDualTurretProjectileState,
  stepDualTurretProjectiles,
} from "./free-roam-dual-turret-projectiles.js";
import {
  ensureDualTurretPurchaseState,
  finishDualTurretPurchaseStep,
  prepareDualTurretPurchaseRoom,
  prepareDualTurretPurchaseStep,
} from "./free-roam-dual-turret-purchase.js";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom, prepareDualTurretPurchaseRoom};
export const WORLD = base.WORLD;

export function createFreeWorld() {
  const world = base.createFreeWorld();
  ensureDualTurretBoat(world, {activate: true});
  prepareDualTurretPurchaseRoom(world);
  ensureDualTurretProjectileState(world);
  return world;
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureDualTurretBoat(world, {activate: false});
  ensureDualTurretPurchaseState(world);
  ensureDualTurretProjectileState(world);
  const purchaseContext = prepareDualTurretPurchaseStep(world);
  const boatContext = prepareDualTurretBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  finishDualTurretBoatStep(world, boatContext, safeDt);
  finishDualTurretPurchaseStep(purchaseContext);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  stepDualTurretProjectiles(world, safeDt);
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
