"use strict";

import {
  DUAL_TURRET_ARMOR_POINTS,
  DUAL_TURRET_HULL_POINTS,
  DUAL_TURRET_RECOVERY_SECONDS,
  DUAL_TURRET_START_AMMO,
} from "./free-roam-dual-turret-config.js?v=2";
import {
  dualTurretBoat,
  prepareDualTurretBoatRoom,
} from "./free-roam-dual-turret-boat.js?v=2";
import {ensureDualTurretPurchaseState} from "./free-roam-dual-turret-purchase.js?v=2";

const DOCK_CANDIDATES = Object.freeze([
  Object.freeze({x: 282, y: 102}),
  Object.freeze({x: 138, y: 102}),
  Object.freeze({x: 282, y: 126}),
  Object.freeze({x: 138, y: 126}),
  Object.freeze({x: 210, y: 108}),
]);

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 220) world.events.splice(0, world.events.length - 220);
}

export function ensureDualTurretPrototypeState(world) {
  world.freeDualTurretPrototype ||= {
    recoveryRemaining: null,
    warned30: false,
    warned10: false,
    revision: 2,
  };
  const state = world.freeDualTurretPrototype;
  if (!Number.isFinite(Number(state.revision))) state.revision = 2;
  if (state.recoveryRemaining != null && !Number.isFinite(Number(state.recoveryRemaining))) {
    state.recoveryRemaining = null;
  }
  state.warned30 = Boolean(state.warned30);
  state.warned10 = Boolean(state.warned10);
  return state;
}

function chooseDockPosition(world, boat) {
  const obstacles = (world.boats || []).filter(candidate => (
    candidate
    && candidate.id !== boat.id
    && !candidate.sunk
    && !candidate.reserved
    && Number.isFinite(Number(candidate.x))
    && Number.isFinite(Number(candidate.y))
  ));
  let best = DOCK_CANDIDATES[0];
  let bestClearance = -Infinity;
  for (const candidate of DOCK_CANDIDATES) {
    const clearance = obstacles.length
      ? Math.min(...obstacles.map(obstacle => distance(candidate, obstacle)))
      : Infinity;
    if (clearance > bestClearance) {
      best = candidate;
      bestClearance = clearance;
    }
  }
  return best;
}

function fullyRestorePrototype(world, boat) {
  const position = chooseDockPosition(world, boat);
  boat.x = position.x;
  boat.y = position.y;
  boat.heading = 0;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.driver = null;
  boat.crew = [null, null];
  boat.sunk = false;
  boat.reserved = false;
  boat.connectionActivated = true;
  boat.structuralHull = DUAL_TURRET_HULL_POINTS;
  boat.maxStructuralHull = DUAL_TURRET_HULL_POINTS;
  boat.hull = 100;
  boat.armor = DUAL_TURRET_ARMOR_POINTS;
  boat.armorMax = DUAL_TURRET_ARMOR_POINTS;
  boat.water = 0;
  boat.leak = 0;
  boat.fuel = 100;
  boat.engineTemp = 24;
  boat.engineStalled = true;
  boat.prototypeIdleStall = true;
  boat.pumpActive = false;
  boat.repairPatches = 5;
  boat.hullRepairProgress = 0;
  boat.repairQuarter = 0;
  boat.dualRepairProgress = 0;
  boat.dualRepairQuarter = 0;
  boat.emergencyActive = false;
  boat.emergencyRemaining = 45;
  boat.emergencyWarned15 = false;
  boat.emergencyWarned5 = false;
  boat.restartProgress = 0;
  boat.boundaryContact = null;
  boat.collisionCooldown = 0;
  boat.dualCollisionCooldown = 0;
  boat.dualCollisionGraceUntil = (Number(world.time) || 0) + 2.5;
  boat.refuelActive = false;
  boat.refuelProgress = 0;
  boat.engineServiceActive = false;
  boat.engineServiceProgress = 0;
  boat.cargo = [];
  boat.cargoWeight = 0;
  boat.prototypeRevision = 2;
  for (const turret of boat.turrets || []) {
    turret.assignedPlayer = null;
    turret.cooldown = 0;
    turret.ammo = DUAL_TURRET_START_AMMO;
  }
  return boat;
}

export function prepareDualTurretPrototypeRoom(world) {
  ensureDualTurretPurchaseState(world);
  const state = ensureDualTurretPrototypeState(world);
  const boat = prepareDualTurretBoatRoom(world);
  fullyRestorePrototype(world, boat);
  state.recoveryRemaining = null;
  state.warned30 = false;
  state.warned10 = false;
  return boat;
}

function upgradeExistingPrototype(boat) {
  if ((Number(boat.prototypeRevision) || 0) >= 2) return;
  boat.prototypeRevision = 2;
  for (const turret of boat.turrets || []) turret.ammo = DUAL_TURRET_START_AMMO;
}

export function prepareDualTurretPrototypeStep(world) {
  ensureDualTurretPurchaseState(world);
  const state = ensureDualTurretPrototypeState(world);
  const boat = dualTurretBoat(world);
  if (!boat || boat.reserved) return {boat, state};
  upgradeExistingPrototype(boat);

  const occupied = (boat.crew || []).some(Number.isInteger);
  if (!boat.sunk && !occupied) {
    boat.throttle = 0;
    if (Math.abs(Number(boat.speed) || 0) < 0.15) boat.speed = 0;
    if (!boat.emergencyActive) {
      boat.engineStalled = true;
      boat.prototypeIdleStall = true;
    }
  } else if (!boat.sunk && occupied && boat.prototypeIdleStall) {
    const safeToStart = (Number(boat.fuel) || 0) > 0.01
      && (Number(boat.water) || 0) <= 35
      && (Number(boat.structuralHull) || 0) >= 5
      && (Number(boat.engineTemp) || 0) < 92
      && !boat.emergencyActive;
    if (safeToStart) {
      boat.engineStalled = false;
      boat.prototypeIdleStall = false;
    }
  }
  return {boat, state};
}

export function finishDualTurretPrototypeStep(world, context, dt) {
  const boat = context?.boat || dualTurretBoat(world);
  const state = context?.state || ensureDualTurretPrototypeState(world);
  if (!boat || boat.reserved) return boat;

  if (!boat.sunk) {
    state.recoveryRemaining = null;
    state.warned30 = false;
    state.warned10 = false;
    boat.prototypeRecoveryRemaining = null;
    return boat;
  }

  if (state.recoveryRemaining == null) {
    state.recoveryRemaining = DUAL_TURRET_RECOVERY_SECONDS;
    state.warned30 = false;
    state.warned10 = false;
    emit(world, "dual-turret-recovery-start", "Тестовый бронекатер затонул. Полностью восстановленный катер появится у причала через минуту.", [0, 1], {
      boatId: boat.id,
      seconds: DUAL_TURRET_RECOVERY_SECONDS,
      x: boat.x,
      y: boat.y,
    });
  }

  state.recoveryRemaining = Math.max(0, Number(state.recoveryRemaining) - Math.max(0, Number(dt) || 0));
  boat.prototypeRecoveryRemaining = state.recoveryRemaining;
  if (state.recoveryRemaining <= 30 && !state.warned30) {
    state.warned30 = true;
    emit(world, "dual-turret-recovery-warning", "Тестовый бронекатер восстановится через 30 секунд.", [0, 1], {seconds: 30});
  }
  if (state.recoveryRemaining <= 10 && !state.warned10) {
    state.warned10 = true;
    emit(world, "dual-turret-recovery-warning", "Тестовый бронекатер восстановится через 10 секунд.", [0, 1], {seconds: 10});
  }
  if (state.recoveryRemaining > 0) return boat;

  fullyRestorePrototype(world, boat);
  state.recoveryRemaining = null;
  state.warned30 = false;
  state.warned10 = false;
  emit(world, "dual-turret-recovered", "Тестовый двухместный бронекатер полностью восстановлен у причала. Патронов в каждой установке 1000.", [0, 1], {
    boatId: boat.id,
    x: boat.x,
    y: boat.y,
  });
  return boat;
}
