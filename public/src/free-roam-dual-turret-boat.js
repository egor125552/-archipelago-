"use strict";

import {
  applyPlayerBoatDamage,
  ensurePlayerBoat,
  finishPlayerBoatStep,
  playerAboardBoat,
  preparePlayerBoatStep,
} from "./free-roam-player-boats.js?v=1";
import {
  DUAL_TURRET_ARMOR_POINTS,
  DUAL_TURRET_BOARDING_RANGE,
  DUAL_TURRET_BOAT_ID,
  DUAL_TURRET_BOAT_TYPE,
  DUAL_TURRET_COLLISION_RADIUS,
  DUAL_TURRET_DEFINITIONS,
  DUAL_TURRET_HULL_POINTS,
  DUAL_TURRET_START_AMMO,
} from "./free-roam-dual-turret-config.js?v=3";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function emptyTurret(definition, seatIndex) {
  return {
    id: definition.id,
    label: definition.label,
    playerIndex: definition.playerIndex,
    seatIndex,
    side: definition.side,
    minimumRelativeHeading: definition.minimumRelativeHeading,
    maximumRelativeHeading: definition.maximumRelativeHeading,
    assignedPlayer: null,
    heading: 0,
    ammo: DUAL_TURRET_START_AMMO,
    cooldown: 0,
    lastDeniedAt: -999,
  };
}

function createBoat() {
  return ensurePlayerBoat({
    id: DUAL_TURRET_BOAT_ID,
    owner: null,
    driver: null,
    boatType: DUAL_TURRET_BOAT_TYPE,
    label: "двухместный бронекатер",
    crewCapacity: 2,
    collisionRadius: DUAL_TURRET_COLLISION_RADIUS,
    boardingRange: DUAL_TURRET_BOARDING_RANGE,
    cargoCapacity: 5,
    audioProfile: "standard",
    x: 210,
    y: 102,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    hull: 100,
    structuralHull: DUAL_TURRET_HULL_POINTS,
    maxStructuralHull: DUAL_TURRET_HULL_POINTS,
    armor: DUAL_TURRET_ARMOR_POINTS,
    armorMax: DUAL_TURRET_ARMOR_POINTS,
    water: 0,
    leak: 0,
    fuel: 100,
    engineTemp: 24,
    engineStalled: false,
    prototypeIdleStall: false,
    pumpActive: false,
    repairPatches: 5,
    hullRepairProgress: 0,
    repairQuarter: 0,
    emergencyActive: false,
    emergencyRemaining: 45,
    emergencyWarned15: false,
    emergencyWarned5: false,
    restartProgress: 0,
    sunk: false,
    reserved: false,
    connectionActivated: true,
    collisionCooldown: 0,
    additionalCollisionCooldown: 0,
    crew: [null, null],
    turrets: DUAL_TURRET_DEFINITIONS.map(emptyTurret),
    refuelCanisters: 1,
    refuelActive: false,
    refuelProgress: 0,
    engineServiceActive: false,
    engineServiceProgress: 0,
    cargo: [],
    cargoWeight: 0,
  });
}

export function isDualTurretBoat(boat) {
  return Boolean(boat && boat.boatType === DUAL_TURRET_BOAT_TYPE);
}

export function dualTurretBoat(world) {
  return (world?.boats || []).find(isDualTurretBoat) || null;
}

function ensureTurrets(boat) {
  const previous = Array.isArray(boat.turrets) ? boat.turrets : [];
  boat.turrets = DUAL_TURRET_DEFINITIONS.map((definition, seatIndex) => {
    const existing = previous.find(candidate => candidate?.id === definition.id) || {};
    return {
      ...emptyTurret(definition, seatIndex),
      ...existing,
      id: definition.id,
      label: definition.label,
      playerIndex: definition.playerIndex,
      seatIndex,
      side: definition.side,
      minimumRelativeHeading: definition.minimumRelativeHeading,
      maximumRelativeHeading: definition.maximumRelativeHeading,
      assignedPlayer: boat.crew?.[seatIndex] ?? null,
      ammo: Math.max(0, Math.floor(Number.isFinite(Number(existing.ammo)) ? Number(existing.ammo) : DUAL_TURRET_START_AMMO)),
      cooldown: Math.max(0, Number(existing.cooldown) || 0),
    };
  });
}

export function ensureDualTurretBoat(world, {activate = true} = {}) {
  if (!world) return null;
  world.boats ||= [];
  let boat = dualTurretBoat(world);
  if (!boat) {
    boat = createBoat();
    while (world.boats.length < DUAL_TURRET_BOAT_ID) world.boats.push(null);
    if (world.boats.length === DUAL_TURRET_BOAT_ID) world.boats.push(boat);
    else world.boats[DUAL_TURRET_BOAT_ID] = boat;
  }
  boat.id = DUAL_TURRET_BOAT_ID;
  boat.boatType = DUAL_TURRET_BOAT_TYPE;
  boat.label = "двухместный бронекатер";
  boat.crewCapacity = 2;
  boat.collisionRadius = DUAL_TURRET_COLLISION_RADIUS;
  boat.boardingRange = DUAL_TURRET_BOARDING_RANGE;
  boat.cargoCapacity = 5;
  boat.audioProfile = "standard";
  boat.maxStructuralHull = Math.max(1, Number(boat.maxStructuralHull) || DUAL_TURRET_HULL_POINTS);
  if (!Number.isFinite(Number(boat.structuralHull))) boat.structuralHull = boat.maxStructuralHull;
  boat.structuralHull = clamp(Number(boat.structuralHull), 0, boat.maxStructuralHull);
  boat.armorMax = Math.max(0, Number(boat.armorMax) || DUAL_TURRET_ARMOR_POINTS);
  if (!Number.isFinite(Number(boat.armor))) boat.armor = boat.armorMax;
  boat.armor = clamp(Number(boat.armor), 0, boat.armorMax);
  boat.hull = clamp(boat.structuralHull / boat.maxStructuralHull * 100, 0, 100);
  boat.engineStalled = Boolean(boat.engineStalled && (
    Number(boat.fuel) <= 0.01
    || Number(boat.water) > 35
    || Number(boat.engineTemp) >= 92
    || boat.emergencyActive
  ));
  boat.prototypeIdleStall = false;
  ensurePlayerBoat(boat);
  ensureTurrets(boat);
  if (activate) {
    boat.reserved = false;
    boat.connectionActivated = true;
    if (!Number.isFinite(Number(boat.x))) boat.x = 210;
    if (!Number.isFinite(Number(boat.y))) boat.y = 102;
  }
  return boat;
}

export function prepareDualTurretBoatRoom(world) {
  const boat = ensureDualTurretBoat(world, {activate: true});
  if (!boat) return null;
  Object.assign(boat, {
    x: 210,
    y: 102,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    driver: null,
    crew: [null, null],
    sunk: false,
    reserved: false,
    connectionActivated: true,
    structuralHull: boat.maxStructuralHull,
    hull: 100,
    armor: boat.armorMax,
    water: 0,
    leak: 0,
    fuel: 100,
    engineTemp: 24,
    engineStalled: false,
    prototypeIdleStall: false,
    emergencyActive: false,
    restartProgress: 0,
    boundaryContact: null,
    collisionCooldown: 0,
    additionalCollisionCooldown: 0,
  });
  for (const turret of boat.turrets) {
    turret.assignedPlayer = null;
    turret.cooldown = 0;
    turret.ammo = DUAL_TURRET_START_AMMO;
  }
  return boat;
}

export function playerDualTurret(world, playerIndex) {
  const boat = dualTurretBoat(world);
  if (!playerAboardBoat(world, playerIndex, boat)) return null;
  return boat.turrets?.find(turret => turret.assignedPlayer === playerIndex) || null;
}

export function applyDualTurretBoatDamage(world, boat, rawDamage, details = {}) {
  if (!isDualTurretBoat(boat)) return {damage: 0, absorbed: 0};
  return applyPlayerBoatDamage(world, boat, rawDamage, details);
}

// Compatibility exports for older tests and modules. They now delegate to the
// same player-boat runtime used by every current and future boat type.
export function prepareDualTurretBoatStep(world) {
  ensureDualTurretBoat(world, {activate: false});
  return preparePlayerBoatStep(world);
}

export function finishDualTurretBoatStep(world, context, dt) {
  return finishPlayerBoatStep(world, context, dt, context?.eventStart || 0);
}
