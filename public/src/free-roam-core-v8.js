"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
import {
  ensureDualTurretBoat,
  finishDualTurretBoatStep,
  playerDualTurret,
  prepareDualTurretBoatRoom,
  prepareDualTurretBoatStep,
} from "./free-roam-dual-turret-boat.js?v=2";
import {
  finishDualTurretWeaponStep,
  prepareDualTurretWeaponStep,
} from "./free-roam-dual-turret-weapons.js?v=2";
import {
  ensureDualTurretProjectileState,
  stepDualTurretProjectiles,
} from "./free-roam-dual-turret-projectiles.js?v=2";
import {
  finishDualTurretDamageControlStep,
  prepareDualTurretDamageControlStep,
} from "./free-roam-dual-turret-damage-control.js?v=1";
import {
  finishDualTurretPrototypeStep,
  prepareDualTurretPrototypeRoom,
  prepareDualTurretPrototypeStep,
} from "./free-roam-dual-turret-test-lifecycle.js?v=1";
import {
  ensureDualTurretPurchaseState,
  finishDualTurretPurchaseStep,
  prepareDualTurretPurchaseRoom,
  prepareDualTurretPurchaseStep,
} from "./free-roam-dual-turret-purchase.js?v=2";

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

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureDualTurretBoat(world, {activate: false});
  ensureDualTurretPurchaseState(world);
  ensureDualTurretProjectileState(world);
  const prototypeContext = prepareDualTurretPrototypeStep(world);
  const purchaseContext = prepareDualTurretPurchaseStep(world);
  const boatContext = prepareDualTurretBoatStep(world);
  const damageControlContext = prepareDualTurretDamageControlStep(world, boatContext);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  finishDualTurretBoatStep(world, boatContext, safeDt);
  finishDualTurretDamageControlStep(world, damageControlContext, safeDt);
  finishDualTurretPurchaseStep(purchaseContext);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  stepDualTurretProjectiles(world, safeDt);
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
