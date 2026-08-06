"use strict";

import * as base from "./free-roam-core-v7.js?v=1";
import {
  ensureDualTurretBoat,
  playerDualTurret,
  prepareDualTurretBoatRoom,
} from "./free-roam-dual-turret-boat.js?v=4";
import {
  finishDualTurretWeaponStep,
  prepareDualTurretWeaponStep,
} from "./free-roam-dual-turret-weapons.js?v=3";
import {ensureDualTurretProjectileState} from "./free-roam-dual-turret-projectiles.js?v=3";
import {
  finishDualTurretPrototypeStep,
  prepareDualTurretPrototypeRoom,
  prepareDualTurretPrototypeStep,
} from "./free-roam-dual-turret-test-lifecycle.js?v=3";
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
import {
  applyPlayerBoatSpeechProfiles,
  ensurePlayerBoatProfiles,
  reconcilePlayerBoatTransitions,
} from "./free-roam-player-boat-profiles.js?v=1";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom, prepareDualTurretPurchaseRoom, prepareDualTurretPrototypeRoom};
export const WORLD = base.WORLD;

export function createFreeWorld() {
  const world = base.createFreeWorld();
  ensureDualTurretBoat(world, {activate: true});
  prepareDualTurretPurchaseRoom(world);
  prepareDualTurretPrototypeRoom(world);
  ensureDualTurretProjectileState(world);
  ensurePlayerBoatProfiles(world);
  reconcilePlayerBoatTransitions(world);
  return world;
}

function boatNeedsContextMaintenance(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (player?.mode !== "boat") return false;
  const boat = world.boats?.[player.activeBoat];
  if (!boat) return false;
  return Boolean(
    boat.refuelActive
    || boat.engineServiceActive
    || Number(boat.fuel) <= 0.01
    || (boat.engineStalled && Number(boat.engineTemp) >= 92)
  );
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureDualTurretBoat(world, {activate: false});
  ensurePlayerBoatProfiles(world);
  const eventStart = world.events?.length || 0;
  const sanitized = {...(nextInput || {})};
  if (!boatNeedsContextMaintenance(world, playerIndex) && capturePlayerBoatInput(world, playerIndex, sanitized)) {
    sanitized.action = false;
  }
  base.setPlayerInput(world, playerIndex, sanitized);
  reconcilePlayerBoatTransitions(world);
  applyPlayerBoatSpeechProfiles(world, eventStart);
}

function translateLegacyBoatDamage(world, context) {
  for (let index = 0; index < (world.boats || []).length; index += 1) {
    const boat = world.boats[index];
    const before = context?.before?.[index];
    const maximum = Number(boat?.maxStructuralHull);
    if (!boat || !before || !Number.isFinite(maximum) || maximum <= 0) continue;
    const armorAlreadyChanged = Number(boat.armor) < Number(before.armor) - 0.0001;
    const compatibilityLoss = Number(before.hull) - Number(boat.hull);
    const structureUnchanged = Math.abs(Number(boat.structuralHull) - Number(before.structuralHull)) < 0.0001;
    if (!armorAlreadyChanged || compatibilityLoss <= 0.0001 || !structureUnchanged) continue;
    // applyCollisionDamage has already consumed armor and leaves the remaining
    // point damage in the old 0..100 hull field. Move only that remaining
    // damage into the extended structure before the compatibility layer runs.
    boat.structuralHull = Math.max(0, Number(before.structuralHull) - compatibilityLoss);
  }
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureDualTurretBoat(world, {activate: false});
  ensureDualTurretPurchaseState(world);
  ensureDualTurretProjectileState(world);
  ensurePlayerBoatProfiles(world);
  reconcilePlayerBoatTransitions(world);
  const eventStart = world.events?.length || 0;
  const prototypeContext = prepareDualTurretPrototypeStep(world);
  const purchaseContext = prepareDualTurretPurchaseStep(world);
  const playerBoatContext = preparePlayerBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const result = base.stepFreeWorld(world, safeDt);
  reconcilePlayerBoatTransitions(world);
  translateLegacyBoatDamage(world, playerBoatContext);
  finishPlayerBoatStep(world, playerBoatContext, safeDt, eventStart);
  finishDualTurretPurchaseStep(purchaseContext);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  finishDualTurretPrototypeStep(world, prototypeContext, safeDt);
  reconcilePlayerBoatTransitions(world);
  applyPlayerBoatSpeechProfiles(world, eventStart);
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
