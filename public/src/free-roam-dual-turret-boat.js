"use strict";

import {applyBoatDamage} from "./collision-model.js";
import {
  DUAL_TURRET_ARMOR_POINTS,
  DUAL_TURRET_BOARDING_RANGE,
  DUAL_TURRET_BOAT_ID,
  DUAL_TURRET_BOAT_TYPE,
  DUAL_TURRET_COLLISION_RADIUS,
  DUAL_TURRET_DEFINITIONS,
  DUAL_TURRET_HULL_POINTS,
  DUAL_TURRET_RECOVERY_SECONDS,
  DUAL_TURRET_START_AMMO,
} from "./free-roam-dual-turret-config.js?v=3";

export const DUAL_TURRET_CONTROLLER_VERSION = "4.0.0";

const WORLD = Object.freeze({width: 420, height: 320, shoreY: 72, shoreMinX: 118, shoreMaxX: 302});
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function createTurret(definition, seatIndex) {
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

function createController(playerCount = 2) {
  return {
    version: DUAL_TURRET_CONTROLLER_VERSION,
    boatId: DUAL_TURRET_BOAT_ID,
    turrets: DUAL_TURRET_DEFINITIONS.map(createTurret),
    recoveryRemaining: null,
    recoveryWarned30: false,
    recoveryWarned10: false,
    rawActionHeld: Array.from({length: playerCount}, () => false),
    previousWeapon: Array.from({length: playerCount}, () => false),
    nextShotId: 1,
    weaponMode: "instant",
  };
}

function createBoat() {
  return {
    id: DUAL_TURRET_BOAT_ID,
    owner: null,
    driver: null,
    boatType: DUAL_TURRET_BOAT_TYPE,
    label: "двухместный бронекатер",
    crewCapacity: 2,
    crew: [null, null],
    collisionRadius: DUAL_TURRET_COLLISION_RADIUS,
    boardingRange: DUAL_TURRET_BOARDING_RANGE,
    cargoCapacity: 5,
    audioProfile: "dual-turret",
    x: 210,
    y: 102,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    hull: DUAL_TURRET_HULL_POINTS,
    hullMax: DUAL_TURRET_HULL_POINTS,
    armor: DUAL_TURRET_ARMOR_POINTS,
    armorMax: DUAL_TURRET_ARMOR_POINTS,
    water: 0,
    leak: 0,
    fuel: 100,
    engineTemp: 24,
    engineStalled: false,
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
    refuelCanisters: 1,
    refuelActive: false,
    refuelProgress: 0,
    engineServiceActive: false,
    engineServiceProgress: 0,
    cargo: [],
    cargoWeight: 0,
    cargoPumpBonus: 0,
  };
}

function normalizeTurrets(state) {
  const old = Array.isArray(state.turrets) ? state.turrets : [];
  state.turrets = DUAL_TURRET_DEFINITIONS.map((definition, seatIndex) => {
    const turret = old.find(candidate => candidate?.id === definition.id) || createTurret(definition, seatIndex);
    const ammo = Number.isFinite(Number(turret.ammo)) ? Number(turret.ammo) : DUAL_TURRET_START_AMMO;
    Object.assign(turret, {
      id: definition.id,
      label: definition.label,
      playerIndex: definition.playerIndex,
      seatIndex,
      side: definition.side,
      minimumRelativeHeading: definition.minimumRelativeHeading,
      maximumRelativeHeading: definition.maximumRelativeHeading,
      assignedPlayer: Number.isInteger(turret.assignedPlayer) ? turret.assignedPlayer : null,
      heading: Number(turret.heading) || 0,
      ammo: Math.max(0, Math.floor(ammo)),
      cooldown: Math.max(0, Number(turret.cooldown) || 0),
      lastDeniedAt: Number.isFinite(Number(turret.lastDeniedAt)) ? Number(turret.lastDeniedAt) : -999,
    });
    return turret;
  });
}

function normalizeController(state, playerCount) {
  state.version = DUAL_TURRET_CONTROLLER_VERSION;
  state.boatId = DUAL_TURRET_BOAT_ID;
  state.weaponMode = "instant";
  state.nextShotId = Math.max(1, Math.floor(Number(state.nextShotId) || 1));
  state.rawActionHeld = Array.isArray(state.rawActionHeld) ? state.rawActionHeld : [];
  state.previousWeapon = Array.isArray(state.previousWeapon) ? state.previousWeapon : [];
  while (state.rawActionHeld.length < playerCount) state.rawActionHeld.push(false);
  while (state.previousWeapon.length < playerCount) state.previousWeapon.push(false);
  normalizeTurrets(state);
  return state;
}

function normalizeBoat(boat) {
  boat.id = DUAL_TURRET_BOAT_ID;
  boat.boatType = DUAL_TURRET_BOAT_TYPE;
  boat.label = "двухместный бронекатер";
  boat.crewCapacity = 2;
  boat.collisionRadius = DUAL_TURRET_COLLISION_RADIUS;
  boat.boardingRange = DUAL_TURRET_BOARDING_RANGE;
  boat.cargoCapacity = Math.max(1, Math.floor(Number(boat.cargoCapacity) || 5));
  boat.audioProfile = "dual-turret";
  boat.hullMax = DUAL_TURRET_HULL_POINTS;

  if (Number.isFinite(Number(boat.structuralHull))) boat.hull = Number(boat.structuralHull);
  else if (Number.isFinite(Number(boat.maxStructuralHull)) && Number(boat.hull) <= 100) {
    boat.hull = Number(boat.hull) / 100 * DUAL_TURRET_HULL_POINTS;
  }
  boat.hull = clamp(Number.isFinite(Number(boat.hull)) ? Number(boat.hull) : DUAL_TURRET_HULL_POINTS, 0, boat.hullMax);
  delete boat.structuralHull;
  delete boat.maxStructuralHull;

  boat.armorMax = DUAL_TURRET_ARMOR_POINTS;
  boat.armor = clamp(Number.isFinite(Number(boat.armor)) ? Number(boat.armor) : boat.armorMax, 0, boat.armorMax);
  if (!Array.isArray(boat.crew)) boat.crew = [null, null];
  boat.crew.length = 2;
  for (let index = 0; index < 2; index += 1) {
    if (!Number.isInteger(boat.crew[index])) boat.crew[index] = null;
  }
  if (Number.isInteger(boat.driver) && !boat.crew.includes(boat.driver)) {
    const free = boat.crew.findIndex(value => !Number.isInteger(value));
    boat.crew[free >= 0 ? free : 0] = boat.driver;
  }

  boat.cargo = Array.isArray(boat.cargo) ? boat.cargo : [];
  boat.cargoWeight = Number(boat.cargoWeight) || 0;
  boat.cargoPumpBonus = Number(boat.cargoPumpBonus) || 0;
  boat.x = Number.isFinite(Number(boat.x)) ? Number(boat.x) : 210;
  boat.y = Number.isFinite(Number(boat.y)) ? Number(boat.y) : 102;
  boat.heading = Number(boat.heading) || 0;
  boat.speed = Number(boat.speed) || 0;
  boat.throttle = Number(boat.throttle) || 0;
  boat.rudder = Number(boat.rudder) || 0;
  boat.water = Number(boat.water) || 0;
  boat.leak = Number(boat.leak) || 0;
  boat.fuel = Number.isFinite(Number(boat.fuel)) ? Number(boat.fuel) : 100;
  boat.engineTemp = Number.isFinite(Number(boat.engineTemp)) ? Number(boat.engineTemp) : 24;
  boat.repairPatches = Number.isInteger(boat.repairPatches) ? boat.repairPatches : 5;
  return boat;
}

export function isDualTurretBoat(boat) {
  return Boolean(boat && boat.boatType === DUAL_TURRET_BOAT_TYPE);
}

export function dualTurretBoat(world) {
  const configured = world?.boats?.[world?.freeDualTurretBoat?.boatId ?? DUAL_TURRET_BOAT_ID];
  return isDualTurretBoat(configured) ? configured : (world?.boats || []).find(isDualTurretBoat) || null;
}

function validCrewMember(world, playerIndex, boat) {
  const player = world?.players?.[playerIndex];
  const presence = world?.freeActivities?.presence;
  return Boolean(
    Number.isInteger(playerIndex)
    && player
    && player.mode === "boat"
    && player.activeBoat === boat.id
    && player.combat?.alive !== false
    && (!Array.isArray(presence) || presence[playerIndex] !== false)
  );
}

function syncCrew(world, state, boat) {
  for (let seat = 0; seat < boat.crew.length; seat += 1) {
    const playerIndex = boat.crew[seat];
    if (Number.isInteger(playerIndex) && !validCrewMember(world, playerIndex, boat)) boat.crew[seat] = null;
  }
  if (Number.isInteger(boat.driver) && !validCrewMember(world, boat.driver, boat)) boat.driver = null;
  if (Number.isInteger(boat.driver) && !boat.crew.includes(boat.driver)) {
    const free = boat.crew.findIndex(value => !Number.isInteger(value));
    boat.crew[free >= 0 ? free : 0] = boat.driver;
  }
  if (!Number.isInteger(boat.driver) || !boat.crew.includes(boat.driver)) {
    boat.driver = boat.crew.find(Number.isInteger) ?? null;
  }
  for (const playerIndex of boat.crew.filter(Number.isInteger)) {
    const player = world.players[playerIndex];
    player.mode = "boat";
    player.activeBoat = boat.id;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading;
  }
  for (let seat = 0; seat < state.turrets.length; seat += 1) {
    state.turrets[seat].assignedPlayer = boat.crew[seat] ?? null;
  }
}

export function ensureDualTurretBoatState(world, {activate = true} = {}) {
  if (!world) return null;
  world.boats ||= [];
  const playerCount = world.players?.length || 2;
  const state = normalizeController(world.freeDualTurretBoat ||= createController(playerCount), playerCount);

  let boat = world.boats[DUAL_TURRET_BOAT_ID];
  if (!isDualTurretBoat(boat)) {
    const migratedIndex = world.boats.findIndex(isDualTurretBoat);
    boat = migratedIndex >= 0 ? world.boats[migratedIndex] : createBoat();
    if (migratedIndex >= 0 && migratedIndex !== DUAL_TURRET_BOAT_ID) world.boats[migratedIndex] = null;
    while (world.boats.length <= DUAL_TURRET_BOAT_ID) world.boats.push(null);
    world.boats[DUAL_TURRET_BOAT_ID] = boat;
  }

  normalizeBoat(boat);
  boat.turrets = state.turrets;
  if (activate) {
    boat.reserved = false;
    boat.connectionActivated = true;
  }
  syncCrew(world, state, boat);
  return state;
}

export function ensureDualTurretBoat(world, options = {}) {
  ensureDualTurretBoatState(world, options);
  return dualTurretBoat(world);
}

function nearShore(boat) {
  return boat.y <= WORLD.shoreY + 18 && boat.x >= WORLD.shoreMinX && boat.x <= WORLD.shoreMaxX;
}

function nearbyCargo(world, player) {
  if (player?.combat?.carriedCrate) return true;
  const range = player?.mode === "boat" ? 12 : 4;
  return (world?.freeActivities?.crates || []).some(crate => crate?.state === "world" && distance(crate, player) <= range);
}

function removeCrew(boat, playerIndex) {
  for (let seat = 0; seat < boat.crew.length; seat += 1) {
    if (boat.crew[seat] === playerIndex) boat.crew[seat] = null;
  }
  if (boat.driver === playerIndex) boat.driver = null;
}

function exitPassenger(world, state, playerIndex, boat) {
  const player = world.players[playerIndex];
  removeCrew(boat, playerIndex);
  const lands = nearShore(boat);
  player.mode = lands ? "foot" : "swim";
  player.activeBoat = null;
  player.x = clamp(boat.x + (playerIndex ? 7 : -7), 5, WORLD.width - 5);
  player.y = lands ? WORLD.shoreY - 7 : clamp(boat.y + 8, 5, WORLD.height - 5);
  player.heading = boat.heading;
  emit(world, "exit", lands ? "Ты вышел на берег." : "Ты спрыгнул в воду.", [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    x: player.x,
    y: player.y,
  });
  syncCrew(world, state, boat);
}

function boardPassenger(world, state, playerIndex, boat) {
  const seat = boat.crew.findIndex(value => !Number.isInteger(value));
  if (seat < 0) return false;
  const player = world.players[playerIndex];
  boat.crew[seat] = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  state.turrets[seat].assignedPlayer = playerIndex;
  emit(world, "enter", `Ты занял ${seat === 0 ? "место рулевого" : "второе место"} на двухместном бронекатере.`, [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    seat,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

export function prepareDualTurretInput(world, playerIndex, nextInput) {
  const state = ensureDualTurretBoatState(world, {activate: false});
  const boat = dualTurretBoat(world);
  const player = world?.players?.[playerIndex];
  const sanitized = {...(nextInput || {})};
  if (!state || !boat || !player) return sanitized;

  const pressed = Boolean(sanitized.action);
  const rising = pressed && !state.rawActionHeld[playerIndex];
  state.rawActionHeld[playerIndex] = pressed;
  const aboard = player.mode === "boat" && player.activeBoat === boat.id && boat.crew.includes(playerIndex);
  const passenger = aboard && boat.driver !== playerIndex;

  if (passenger) {
    sanitized.up = false;
    sanitized.down = false;
    sanitized.left = false;
    sanitized.right = false;
    sanitized.guide = false;
    if (rising && !nearbyCargo(world, player)) {
      if (Math.abs(Number(boat.speed) || 0) > 0.35) {
        emit(world, "action-denied", "Чтобы выйти из бронекатера, полностью остановись.", [playerIndex], {sourcePlayer: playerIndex, boatId: boat.id});
      } else {
        exitPassenger(world, state, playerIndex, boat);
      }
      sanitized.action = false;
    }
    return sanitized;
  }

  if (!rising || !["foot", "swim", "roof"].includes(player.mode) || nearbyCargo(world, player)) return sanitized;
  if (boat.sunk || boat.reserved || !Number.isInteger(boat.driver) || boat.crew.filter(Number.isInteger).length >= 2) return sanitized;
  const point = player.mode === "roof" && player.activeBoat === boat.id ? boat : player;
  if (distance(point, boat) > DUAL_TURRET_BOARDING_RANGE) return sanitized;
  if (boardPassenger(world, state, playerIndex, boat)) sanitized.action = false;
  return sanitized;
}

export function prepareDualTurretBoatStep(world) {
  return {
    state: ensureDualTurretBoatState(world, {activate: false}),
    boat: dualTurretBoat(world),
  };
}

function restoreBoat(state, boat) {
  Object.assign(boat, {
    x: 210,
    y: 102,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    driver: null,
    hull: DUAL_TURRET_HULL_POINTS,
    hullMax: DUAL_TURRET_HULL_POINTS,
    armor: DUAL_TURRET_ARMOR_POINTS,
    armorMax: DUAL_TURRET_ARMOR_POINTS,
    water: 0,
    leak: 0,
    fuel: 100,
    engineTemp: 24,
    engineStalled: false,
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
    boundaryContact: null,
    collisionCooldown: 0,
    cargoWeight: 0,
  });
  boat.crew.fill(null);
  boat.cargo.length = 0;
  for (const turret of state.turrets) {
    turret.assignedPlayer = null;
    turret.heading = 0;
    turret.cooldown = 0;
    turret.ammo = DUAL_TURRET_START_AMMO;
  }
}

function updateRecovery(world, state, boat, dt) {
  if (!boat.sunk) {
    state.recoveryRemaining = null;
    state.recoveryWarned30 = false;
    state.recoveryWarned10 = false;
    return;
  }
  if (state.recoveryRemaining == null) {
    state.recoveryRemaining = DUAL_TURRET_RECOVERY_SECONDS;
    state.recoveryWarned30 = false;
    state.recoveryWarned10 = false;
    emit(world, "dual-turret-recovery-start", "Бронекатер затонул. Новый катер появится у причала через минуту.", [0, 1], {boatId: boat.id, seconds: DUAL_TURRET_RECOVERY_SECONDS, x: boat.x, y: boat.y});
  }
  state.recoveryRemaining = Math.max(0, Number(state.recoveryRemaining) - Math.max(0, Number(dt) || 0));
  if (state.recoveryRemaining <= 30 && !state.recoveryWarned30) {
    state.recoveryWarned30 = true;
    emit(world, "dual-turret-recovery-warning", "Бронекатер восстановится через 30 секунд.", [0, 1], {seconds: 30});
  }
  if (state.recoveryRemaining <= 10 && !state.recoveryWarned10) {
    state.recoveryWarned10 = true;
    emit(world, "dual-turret-recovery-warning", "Бронекатер восстановится через 10 секунд.", [0, 1], {seconds: 10});
  }
  if (state.recoveryRemaining > 0) return;
  restoreBoat(state, boat);
  state.recoveryRemaining = null;
  emit(world, "dual-turret-recovered", "Двухместный бронекатер полностью восстановлен у причала.", [0, 1], {boatId: boat.id, x: boat.x, y: boat.y});
}

export function finishDualTurretBoatStep(world, context, dt) {
  const state = context?.state || ensureDualTurretBoatState(world, {activate: false});
  const boat = context?.boat || dualTurretBoat(world);
  if (!state || !boat) return boat;
  syncCrew(world, state, boat);
  updateRecovery(world, state, boat, dt);
  return boat;
}

export function prepareDualTurretBoatRoom(world) {
  const state = ensureDualTurretBoatState(world, {activate: true});
  const boat = dualTurretBoat(world);
  if (!state || !boat) return null;
  restoreBoat(state, boat);
  state.recoveryRemaining = null;
  state.recoveryWarned30 = false;
  state.recoveryWarned10 = false;
  return boat;
}

export function playerDualTurret(world, playerIndex) {
  const state = world?.freeDualTurretBoat;
  const boat = dualTurretBoat(world);
  const player = world?.players?.[playerIndex];
  if (!state || !boat || player?.mode !== "boat" || player.activeBoat !== boat.id) return null;
  const seat = boat.crew.indexOf(playerIndex);
  return seat >= 0 ? state.turrets?.[seat] || null : null;
}

export function applyDualTurretBoatDamage(world, boat, rawDamage, details = {}) {
  if (!isDualTurretBoat(boat) || boat.sunk) return {damage: 0, absorbed: 0};
  const result = applyBoatDamage(boat, rawDamage, {armorShare: 0.72, leakShare: 0.045});
  if (details.emit !== false) emit(world, "player-boat-damaged", `${boat.label} получил повреждение.`, boat.crew.filter(Number.isInteger), {
    boatId: boat.id,
    sourcePlayer: details.sourcePlayer,
    damage: result.damage,
    absorbed: result.absorbed,
    armor: boat.armor,
    hull: boat.hull,
    hullMax: boat.hullMax,
    x: boat.x,
    y: boat.y,
  });
  return result;
}