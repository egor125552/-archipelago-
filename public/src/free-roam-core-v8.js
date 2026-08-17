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
} from "./free-roam-boat-physics.js?v=2";
import {
  activeBoatIds,
  attachBoatTransitionMetadata,
} from "./free-roam-boat-events.js?v=1";
import {isPlayerNearMerchant} from "./free-roam-shop.js?v=5";
import {applyCombatDamage} from "./free-roam-combat-v2.js?v=6";
import {attachVesselArchitecture, listNativeVessels, runVesselSystems} from "./vessel/vessel-runtime.js?v=2";
import {runVesselPhysics} from "./vessel/vessel-runtime-v3.js?v=1";
import {FreeRoamSpatialManager} from "./spatial/spatial-free-roam-integration.js";
import {syncFreeRoamVesselSpatialMirrors} from "./spatial/spatial-vessel-adapter.js";
import {
  announceFreeRoamSpatialGameplay,
  finishFreeRoamSpatialGameplayStep,
  prepareFreeRoamSpatialGameplayStep,
  spatialGameplayStatus,
} from "./spatial/spatial-free-roam-gameplay.js";
import {FREE_ROAM_SPATIAL_LOCATIONS} from "./locations/free-roam-location-registry.js";

export * from "./free-roam-core-v7.js?v=1";
export {prepareDualTurretBoatRoom};
export const WORLD = base.WORLD;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

const spatialIntegration = new FreeRoamSpatialManager({
  locations: FREE_ROAM_SPATIAL_LOCATIONS,
  mode: "production",
});

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

function normalizeDualTurretOwnership(world, playerIndex, eventStart = 0) {
  const boat = dualTurretBoat(world);
  const player = world?.players?.[playerIndex];
  if (!boat || !player || player.mode !== "boat" || player.activeBoat !== boat.id) return boat;

  // On a walkable vessel, being aboard is not the same thing as sitting at the
  // helm. The vessel deck system is the only authority allowed to grant
  // driver control after the physical helm station has actually been claimed.
  if (!Number.isInteger(boat.driver) && player.vesselDeckInputOwned !== true) boat.driver = playerIndex;
  if (!Number.isInteger(boat.owner)) boat.owner = Number.isInteger(boat.driver) ? boat.driver : playerIndex;

  for (const event of (world?.events || []).slice(eventStart)) {
    if (event?.type !== "enter" || !event?.targets?.includes(playerIndex)) continue;
    if (typeof event.text === "string" && event.text.includes("угнал чужую лодку")) {
      event.text = "Ты поднялся на свой двухместный бронекатер.";
    }
    event.boatId = boat.id;
    event.ownedBoat = true;
  }
  return boat;
}

function captureDualTurretDurability(world) {
  const boat = dualTurretBoat(world);
  if (!boat) return null;
  return {
    boatId: boat.id,
    hull: Math.max(0, Number(boat.hull) || 0),
    hullMax: Math.max(1, Number(boat.hullMax) || 300),
    armor: Math.max(0, Number(boat.armor) || 0),
    armorMax: Math.max(0, Number(boat.armorMax) || 0),
    leak: Math.max(0, Number(boat.leak) || 0),
  };
}

function rebalanceDualTurretGunHits(world, eventStart, durability) {
  const boat = dualTurretBoat(world);
  if (!boat || !durability || boat.id !== durability.boatId) return;
  const events = (world?.events || []).slice(eventStart);
  const hits = events.filter(event => event?.type === "gun-boat-hit" && event.targetBoat === boat.id);
  if (!hits.length) return;

  const state = {...durability};
  for (const event of hits) {
    const pistol = event.weapon === "pistol";
    const nominalHullDamage = pistol ? 2 : 5;
    const nominalArmorDamage = nominalHullDamage * 1.45;
    const armorDamage = state.armor > 0 ? Math.min(state.armor, nominalArmorDamage) : 0;
    const armorCoverage = nominalArmorDamage > 0 ? clamp(armorDamage / nominalArmorDamage, 0, 1) : 0;
    const hullDamage = nominalHullDamage * (1 - armorCoverage * 0.78);
    const leakIncrease = (pistol ? 0.06 : 0.18) * (1 - armorCoverage * 0.72);

    state.armor = Math.max(0, state.armor - armorDamage);
    state.hull = clamp(state.hull - hullDamage, 0.05, state.hullMax);
    state.leak = clamp(state.leak + leakIncrease, 0, 16);

    event.damage = Math.round(hullDamage * 100) / 100;
    event.armorDamage = Math.round(armorDamage * 100) / 100;
    event.armor = state.armor;
    event.armorMax = state.armorMax;
    event.hull = state.hull;
    event.hullMax = state.hullMax;
    event.text = `Попадание по бронекатеру. Броня ${Math.round(state.armor)} из ${Math.round(state.armorMax)}, корпус ${Math.round(state.hull)} из ${Math.round(state.hullMax)}.`;
  }

  boat.armor = state.armor;
  boat.hull = state.hull;
  boat.leak = state.leak;

  for (const event of events) {
    if (event?.type !== "gun-boat-damaged" || event.targetBoat !== boat.id) continue;
    event.armor = state.armor;
    event.armorMax = state.armorMax;
    event.hull = state.hull;
    event.hullMax = state.hullMax;
    event.text = `Твой бронекатер под огнём. Броня ${Math.round(state.armor)} из ${Math.round(state.armorMax)}, корпус ${Math.round(state.hull)} из ${Math.round(state.hullMax)}.`;
  }
}

export function merchantOwnsAction(world, playerIndex, nextInput) {
  return Boolean(nextInput?.action && isPlayerNearMerchant(world?.players?.[playerIndex]));
}

export function prepareFreeRoamPlayerInput(world, playerIndex, nextInput) {
  // A walkable vessel system has already validated, consumed and sanitized the
  // input before this legacy compatibility layer. Do not run the old concrete
  // seat controller again or it can reclaim the helm while the player is
  // physically walking on deck.
  if (world?.players?.[playerIndex]?.vesselDeckInputOwned === true) {
    return {...(nextInput || {})};
  }
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
  attachVesselArchitecture(world);
  spatialIntegration.initialize(world);
  syncFreeRoamVesselSpatialMirrors(world, listNativeVessels(world));
  return world;
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureController(world, {activate: false});
  attachVesselArchitecture(world);
  const eventStart = world.events?.length || 0;
  const previousBoatIds = activeBoatIds(world);
  const spatialInput = spatialIntegration.prepareInput(world, playerIndex, nextInput);
  runVesselSystems("before-input", {world, playerIndex, input: spatialInput, eventStart});
  base.setPlayerInput(world, playerIndex, prepareFreeRoamPlayerInput(world, playerIndex, spatialInput));
  normalizeDualTurretOwnership(world, playerIndex, eventStart);
  attachBoatTransitionMetadata(world, eventStart, previousBoatIds);
  applyDualTurretSpeech(world, eventStart);
  runVesselSystems("after-input", {world, playerIndex, input: spatialInput, eventStart});
}

export function stepFreeWorld(world, dt) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  ensureController(world, {activate: false});
  attachVesselArchitecture(world);
  const eventStart = world.events?.length || 0;
  const previousBoatIds = activeBoatIds(world);
  const previousPhysics = captureBoatPhysicsState(world);
  const previousDurability = captureDualTurretDurability(world);
  const boatContext = prepareDualTurretBoatStep(world);
  const weaponContext = prepareDualTurretWeaponStep(world);
  const spatialGameplayContext = prepareFreeRoamSpatialGameplayStep(world, spatialIntegration);
  runVesselSystems("before-step", {world, dt: safeDt, eventStart});
  const previousPresence = spatialIntegration.prepareLegacyStep(world);
  let result;
  try { result = base.stepFreeWorld(world, safeDt); }
  finally { spatialIntegration.finishLegacyStep(world, previousPresence); }
  finishFreeRoamSpatialGameplayStep(world, spatialIntegration, spatialGameplayContext, safeDt, {applyCombatDamage});
  spatialIntegration.sync(world, safeDt, {eventStart});
  announceFreeRoamSpatialGameplay(world, spatialIntegration);
  rebalanceDualTurretGunHits(world, eventStart, previousDurability);
  applyBoatPhysicsProfiles(world, previousPhysics, safeDt, {tuning: CONFIG, eventStart});
  runVesselPhysics({world, dt: safeDt, eventStart, previousStates: previousPhysics, tuning: CONFIG});
  finishDualTurretBoatStep(world, boatContext, safeDt);
  finishDualTurretWeaponStep(world, weaponContext, safeDt);
  attachBoatTransitionMetadata(world, eventStart, previousBoatIds);
  applyDualTurretSpeech(world, eventStart);
  runVesselSystems("after-step", {world, dt: safeDt, eventStart});
  syncFreeRoamVesselSpatialMirrors(world, listNativeVessels(world));
  return result;
}

export function playerStatus(world, playerIndex) {
  const inherited = base.playerStatus(world, playerIndex);
  const spatial = spatialIntegration.status(world, playerIndex);
  const gameplay = spatialGameplayStatus(world, spatialIntegration, playerIndex);
  const status = [inherited, spatial, gameplay].filter(Boolean).join(" ");
  const player = world?.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (boat !== dualTurretBoat(world)) return status;
  const turret = playerDualTurret(world, playerIndex);
  return `${status} Двухместный бронекатер: корпус ${Math.round(boat.hull)} из ${Math.round(boat.hullMax)}, броня ${Math.round(boat.armor)} из ${Math.round(boat.armorMax)}. ${turret ? `${turret.label}: патронов ${turret.ammo}.` : "Установка не назначена."}`;
}
