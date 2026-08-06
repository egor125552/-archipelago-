"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
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
} from "./free-roam-dual-turret-weapons.js?v=4";
import {ensureDualTurretProjectileState} from "./free-roam-dual-turret-projectiles.js?v=4";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom};
export const WORLD = base.WORLD;

export function createFreeWorld() {
  const world = base.createFreeWorld();
  ensureDualTurretBoatState(world, {activate: true});
  prepareDualTurretBoatRoom(world);
  ensureDualTurretProjectileState(world);
  return world;
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureDualTurretBoatState(world, {activate: false});
  base.setPlayerInput(world, playerIndex, prepareDualTurretInput(world, playerIndex, nextInput));
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureDualTurretBoatState(world, {activate: false});
  ensureDualTurretProjectileState(world);
  const boatContext = prepareDualTurretBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  finishDualTurretBoatStep(world, boatContext, safeDt);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
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
