"use strict";

import {
  DUAL_TURRET_ARMOR_POINTS,
  DUAL_TURRET_HULL_POINTS,
  DUAL_TURRET_RECOVERY_SECONDS,
  DUAL_TURRET_START_AMMO,
} from "./free-roam-dual-turret-config.js?v=3";
import {dualTurretBoat, prepareDualTurretBoatRoom} from "./free-roam-dual-turret-boat.js?v=4";
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
    revision: 3,
  };
  const state = world.freeDualTurretPrototype;
  state.revision = 3;
  if (state.recoveryRemaining != null && !Number.isFinite(Number(state.recoveryRemaining))) state.recoveryRemaining = null;
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
    const clearance = obstacles.length ? Math.min(...obstacles.map(obstacle => distance(candidate, obstacle))) : Infinity;
    if (clearance > bestClearance) {
      best = candidate;
      bestClearance = clearance;
    }
  }
  return best;
}

function fullyRestorePrototype(world, boat) {
  const position = chooseDockPosition(world, boat);
  Object.assign(boat, {
    x: position.x,
    y: position.y,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    driver: null,
    crew: [null, null],
    sunk: false,
    reserved: false,
    connectionActivated: true,
    structuralHull: DUAL_TURRET_HULL_POINTS,
    maxStructuralHull: DUAL_TURRET_HULL_POINTS,
    hull: 100,
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
    boundaryContact: null,
    collisionCooldown: 0,
    additionalCollisionCooldown: 0,
    refuelActive: false,
    refuelProgress: 0,
    engineServiceActive: false,
    engineServiceProgress: 0,
    cargo: [],
    cargoWeight: 0,
    prototypeRevision: 3,
  });
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

export function prepareDualTurretPrototypeStep(world) {
  ensureDualTurretPurchaseState(world);
  const state = ensureDualTurretPrototypeState(world);
  const boat = dualTurretBoat(world);
  if (!boat || boat.reserved) return {boat, state};
  if ((Number(boat.prototypeRevision) || 0) < 3) {
    boat.prototypeRevision = 3;
    boat.prototypeIdleStall = false;
    for (const turret of boat.turrets || []) turret.ammo = Math.max(Number(turret.ammo) || 0, DUAL_TURRET_START_AMMO);
  }

  const occupied = (boat.crew || []).some(Number.isInteger);
  if (!boat.sunk && !occupied) {
    boat.throttle = 0;
    boat.rudder = 0;
    if (Math.abs(Number(boat.speed) || 0) < 0.15) boat.speed = 0;
    boat.prototypeIdleStall = false;
    if (boat.engineStalled && Number(boat.fuel) > 0.01 && Number(boat.water) <= 35 && Number(boat.engineTemp) < 92 && !boat.emergencyActive) {
      boat.engineStalled = false;
      boat.restartProgress = 0;
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
