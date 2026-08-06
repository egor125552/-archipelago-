"use strict";

import {applyCollisionDamage, collisionSeverity} from "./collision-model.js";
import {
  DUAL_TURRET_ACCELERATION_FACTOR,
  DUAL_TURRET_ARMOR_POINTS,
  DUAL_TURRET_BOARDING_RANGE,
  DUAL_TURRET_BOAT_ID,
  DUAL_TURRET_BOAT_TYPE,
  DUAL_TURRET_COLLISION_RADIUS,
  DUAL_TURRET_DEFINITIONS,
  DUAL_TURRET_HULL_POINTS,
  DUAL_TURRET_MAX_SPEED,
  DUAL_TURRET_REVERSE_SPEED,
  DUAL_TURRET_START_AMMO,
  DUAL_TURRET_TURN_FACTOR,
  DUAL_TURRET_WEAPON_ID,
} from "./free-roam-dual-turret-config.js";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = value => Number(value) * Math.PI / 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 220) world.events.splice(0, world.events.length - 220);
}

function emptyTurret(definition) {
  return {
    id: definition.id,
    label: definition.label,
    playerIndex: definition.playerIndex,
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
  return {
    id: DUAL_TURRET_BOAT_ID,
    owner: null,
    driver: null,
    boatType: DUAL_TURRET_BOAT_TYPE,
    label: "двухместный бронекатер",
    x: 210,
    y: 90,
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
    dualCollisionCooldown: 0,
    crew: [null, null],
    turrets: DUAL_TURRET_DEFINITIONS.map(emptyTurret),
    refuelCanisters: 1,
    refuelActive: false,
    refuelProgress: 0,
    engineServiceActive: false,
    engineServiceProgress: 0,
    cargo: [],
    cargoWeight: 0,
  };
}

export function isDualTurretBoat(boat) {
  return Boolean(boat && boat.boatType === DUAL_TURRET_BOAT_TYPE);
}

export function dualTurretBoat(world) {
  return (world?.boats || []).find(isDualTurretBoat) || null;
}

function ensureTurrets(boat) {
  const previous = Array.isArray(boat.turrets) ? boat.turrets : [];
  boat.turrets = DUAL_TURRET_DEFINITIONS.map(definition => {
    const existing = previous.find(candidate => candidate?.id === definition.id) || {};
    return {
      ...emptyTurret(definition),
      ...existing,
      id: definition.id,
      label: definition.label,
      playerIndex: definition.playerIndex,
      side: definition.side,
      minimumRelativeHeading: definition.minimumRelativeHeading,
      maximumRelativeHeading: definition.maximumRelativeHeading,
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
  boat.label ||= "двухместный бронекатер";
  boat.owner = null;
  boat.crew = Array.isArray(boat.crew) ? boat.crew.slice(0, 2) : [null, null];
  while (boat.crew.length < 2) boat.crew.push(null);
  boat.maxStructuralHull = Math.max(1, Number(boat.maxStructuralHull) || DUAL_TURRET_HULL_POINTS);
  if (!Number.isFinite(Number(boat.structuralHull))) boat.structuralHull = boat.maxStructuralHull;
  boat.structuralHull = clamp(Number(boat.structuralHull), 0, boat.maxStructuralHull);
  if (!Number.isFinite(Number(boat.armorMax))) boat.armorMax = DUAL_TURRET_ARMOR_POINTS;
  if (!Number.isFinite(Number(boat.armor))) boat.armor = boat.armorMax;
  boat.armor = clamp(Number(boat.armor), 0, Number(boat.armorMax));
  boat.hull = clamp(boat.structuralHull / boat.maxStructuralHull * 100, 0, 100);
  if (!Number.isFinite(Number(boat.dualCollisionCooldown))) boat.dualCollisionCooldown = 0;
  ensureTurrets(boat);
  if (activate) {
    boat.reserved = false;
    boat.connectionActivated = true;
    boat.sunk = false;
    if (!Number.isFinite(Number(boat.x)) || boat.x < 0) boat.x = 210;
    if (!Number.isFinite(Number(boat.y)) || boat.y < 0) boat.y = 90;
  }
  return boat;
}

export function prepareDualTurretBoatRoom(world) {
  const boat = ensureDualTurretBoat(world, {activate: true});
  if (!boat) return null;
  boat.x = 210;
  boat.y = 90;
  boat.heading = 0;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.driver = null;
  boat.crew = [null, null];
  boat.sunk = false;
  boat.reserved = false;
  boat.connectionActivated = true;
  boat.structuralHull = boat.maxStructuralHull;
  boat.hull = 100;
  boat.armor = boat.armorMax;
  boat.water = 0;
  boat.leak = 0;
  boat.engineStalled = false;
  boat.emergencyActive = false;
  for (const turret of boat.turrets) {
    turret.assignedPlayer = null;
    turret.cooldown = 0;
    turret.ammo = DUAL_TURRET_START_AMMO;
  }
  return boat;
}

function inputObjects(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function setInputField(world, playerIndex, key, value, saved) {
  for (const input of inputObjects(world, playerIndex)) {
    saved.push([input, key, input[key]]);
    input[key] = value;
  }
}

function originalInput(world, playerIndex) {
  return world?.freeActivities?.inputs?.[playerIndex]
    || world?.operationInputs?.[playerIndex]
    || world?.inputs?.[playerIndex]
    || {};
}

function present(world, playerIndex) {
  const presence = world?.freeActivities?.presence;
  return !Array.isArray(presence) || Boolean(presence[playerIndex]);
}

function playerOnDualBoat(world, playerIndex, boat = dualTurretBoat(world)) {
  const player = world?.players?.[playerIndex];
  return Boolean(boat && player?.mode === "boat" && player.activeBoat === boat.id && boat.crew?.includes(playerIndex));
}

export function playerDualTurret(world, playerIndex) {
  const boat = dualTurretBoat(world);
  if (!playerOnDualBoat(world, playerIndex, boat)) return null;
  return boat.turrets?.find(turret => turret.playerIndex === playerIndex) || null;
}

function assignCrew(world, playerIndex, boat) {
  const player = world.players?.[playerIndex];
  if (!world.freeDualTurretPurchase?.purchased) return false;
  if (!player || !boat || boat.sunk || !player.combat?.alive) return false;
  const seat = playerIndex;
  boat.crew[seat] = playerIndex;
  if (boat.driver == null) boat.driver = playerIndex;
  const turret = boat.turrets.find(candidate => candidate.playerIndex === playerIndex);
  if (turret) turret.assignedPlayer = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  emit(world, "dual-turret-board", `${playerIndex === boat.driver ? "Ты занял место рулевого" : "Ты занял второе место"}. Твоя ${turret?.label || "установка"} доступна в переключении оружия.`, [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    turretId: turret?.id,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

function restorePersonalWeapon(player) {
  const combat = player?.combat;
  if (!combat || combat.equipped !== DUAL_TURRET_WEAPON_ID) return;
  const preferred = combat.lastPersonalWeapon;
  if (preferred === "automatic" && combat.weapons?.automatic && combat.ammo > 0) combat.equipped = preferred;
  else if (preferred === "pistol" && combat.weapons?.pistol && combat.pistolAmmo > 0) combat.equipped = preferred;
  else if (preferred === "knife" && combat.weapons?.knife) combat.equipped = preferred;
  else combat.equipped = "fists";
}

function removeCrew(world, playerIndex, boat, {announce = true} = {}) {
  const player = world.players?.[playerIndex];
  if (!boat?.crew?.includes(playerIndex)) return false;
  boat.crew = boat.crew.map(value => value === playerIndex ? null : value);
  const turret = boat.turrets.find(candidate => candidate.playerIndex === playerIndex);
  if (turret) turret.assignedPlayer = null;
  restorePersonalWeapon(player);
  if (boat.driver === playerIndex) {
    boat.driver = boat.crew.find(value => Number.isInteger(value)) ?? null;
    boat.throttle = 0;
    boat.rudder = 0;
  }
  if (player && player.mode !== "dead") {
    const docked = boat.y <= 96 && boat.x >= 118 && boat.x <= 302;
    player.mode = docked ? "foot" : "swim";
    player.activeBoat = null;
    player.x = boat.x + (playerIndex === 0 ? -7 : 7);
    player.y = docked ? 65 : boat.y + 9;
    player.heading = boat.heading;
  }
  if (announce) emit(world, "dual-turret-exit", "Ты покинул двухместный бронекатер.", [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    x: player?.x ?? boat.x,
    y: player?.y ?? boat.y,
  });
  return true;
}

function handleCrewActions(world, boat, state, originals) {
  for (let playerIndex = 0; playerIndex < (world.players?.length || 0); playerIndex += 1) {
    const input = originals[playerIndex] || {};
    const rising = Boolean(input.action && !state.previousAction[playerIndex]);
    if (!rising) continue;
    const player = world.players[playerIndex];
    if (playerOnDualBoat(world, playerIndex, boat)) {
      if (Math.abs(Number(boat.speed) || 0) > 0.45) {
        emit(world, "dual-turret-exit-denied", "Сначала почти полностью останови бронекатер.", [playerIndex]);
      } else {
        removeCrew(world, playerIndex, boat);
      }
      continue;
    }
    if (!["foot", "swim", "roof"].includes(player?.mode)) continue;
    if (distance(player, boat) > DUAL_TURRET_BOARDING_RANGE) continue;
    assignCrew(world, playerIndex, boat);
  }
}

function syncCrew(world, boat) {
  for (let playerIndex = 0; playerIndex < (world.players?.length || 0); playerIndex += 1) {
    const player = world.players[playerIndex];
    const aboard = boat.crew.includes(playerIndex);
    const valid = aboard && present(world, playerIndex) && player?.combat?.alive && !boat.sunk;
    if (aboard && !valid) removeCrew(world, playerIndex, boat, {announce: false});
  }
  if (boat.driver != null && !boat.crew.includes(boat.driver)) boat.driver = null;
  if (boat.driver == null) boat.driver = boat.crew.find(value => Number.isInteger(value)) ?? null;
  for (const turret of boat.turrets) turret.assignedPlayer = boat.crew[turret.playerIndex] ?? null;
  for (const playerIndex of boat.crew) {
    if (!Number.isInteger(playerIndex)) continue;
    const player = world.players[playerIndex];
    if (!player || player.mode === "dead") continue;
    player.mode = "boat";
    player.activeBoat = boat.id;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading;
  }
}

export function prepareDualTurretBoatStep(world) {
  const boat = ensureDualTurretBoat(world, {activate: false});
  const state = world.freeDualTurretBoat ||= {
    previousAction: Array.from({length: world.players?.length || 2}, () => false),
  };
  while (state.previousAction.length < world.players.length) state.previousAction.push(false);
  const originals = world.players.map((_, index) => ({...originalInput(world, index)}));
  const saved = [];
  const before = {
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    speed: boat.speed,
    hull: boat.hull,
    structuralHull: boat.structuralHull,
    armor: boat.armor,
    eventStart: world.events?.length || 0,
  };

  handleCrewActions(world, boat, state, originals);

  for (let playerIndex = 0; playerIndex < world.players.length; playerIndex += 1) {
    if (originals[playerIndex].action && (
      playerOnDualBoat(world, playerIndex, boat)
      || distance(world.players[playerIndex], boat) <= DUAL_TURRET_BOARDING_RANGE
    )) setInputField(world, playerIndex, "action", false, saved);
  }

  const crewInputs = boat.crew
    .filter(Number.isInteger)
    .map(playerIndex => originals[playerIndex] || {});
  if (boat.driver != null) {
    const pump = crewInputs.some(input => Boolean(input.pump));
    const repair = crewInputs.some(input => Boolean(input.repair));
    setInputField(world, boat.driver, "pump", pump, saved);
    setInputField(world, boat.driver, "repair", repair, saved);

    // The legacy steering model keeps a small rudder value after a turn and
    // can rotate a stationary boat even when nobody is steering. For the
    // shared patrol boat the rudder belongs exclusively to the current
    // driver's live input. Clearing stale rudder here prevents the second
    // seat (or an earlier frame) from indirectly changing the heading.
    const driverInput = originals[boat.driver] || {};
    if (!driverInput.left && !driverInput.right) boat.rudder = 0;
  }

  // Only the current driver is allowed to feed the shared boat's propulsion
  // and steering model. The second crew member keeps weapon, pump, repair,
  // target and status controls, but cannot accidentally steer through the
  // base operation-steering layer.
  for (const crewPlayer of boat.crew) {
    if (!Number.isInteger(crewPlayer) || crewPlayer === boat.driver) continue;
    for (const key of ["up", "down", "left", "right"]) {
      if (originals[crewPlayer]?.[key]) setInputField(world, crewPlayer, key, false, saved);
    }
  }

  return {boat, state, originals, saved, before};
}

function restoreSaved(saved) {
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    const [input, key, value] = saved[index];
    input[key] = value;
  }
}

function syncStructuralHull(world, boat, before) {
  const maximum = Math.max(1, Number(boat.maxStructuralHull) || DUAL_TURRET_HULL_POINTS);
  const previousCompatibilityHull = clamp(Number(before.hull) || 0, 0, 100);
  const nextCompatibilityHull = clamp(Number(boat.hull) || 0, 0, 100);
  const compatibilityDelta = nextCompatibilityHull - previousCompatibilityHull;
  let nextStructuralHull = Number(before.structuralHull) || 0;

  if (compatibilityDelta < 0) {
    // Legacy systems express damage as points subtracted from the old 100-point
    // hull field. Preserve that amount as real points instead of scaling it
    // back to a percentage of the new 300-point structure.
    const incoming = -compatibilityDelta;
    const armorAlreadyHandled = Number(boat.armor) < Number(before.armor) - 0.0001;
    if (armorAlreadyHandled) {
      nextStructuralHull -= incoming;
    } else {
      const absorbed = Math.min(Number(before.armor) || 0, incoming * 0.72);
      boat.armor = Math.max(0, (Number(before.armor) || 0) - absorbed);
      nextStructuralHull -= incoming - absorbed;
    }
  } else if (compatibilityDelta > 0) {
    nextStructuralHull += compatibilityDelta;
  }

  boat.structuralHull = clamp(nextStructuralHull, 0, maximum);
  if (boat.emergencyActive && boat.structuralHull <= 0) boat.structuralHull = maximum * 0.0005;
  boat.hull = clamp(boat.structuralHull / maximum * 100, 0, 100);

  const fresh = (world.events || []).slice(before.eventStart);
  for (const event of fresh) {
    if (!event || event.targetBoat !== boat.id) continue;
    if (!["enemy-bullet-boat-hit", "enemy-ram-hit"].includes(event.type)) continue;
    event.text = `Бронекатер получил повреждение. Броня ${Math.round(boat.armor)}, корпус ${Math.round(boat.structuralHull)} из ${Math.round(maximum)}.`;
    event.armor = boat.armor;
    event.structuralHull = boat.structuralHull;
  }
}

function applyMotionProfile(world, boat, before, dt) {
  if (boat.sunk || !Number.isFinite(Number(dt)) || dt <= 0) return;
  const fresh = (world.events || []).slice(before.eventStart);
  const collision = fresh.some(event => ["collision", "ram", "anchor"].includes(event?.type)
    && (!Array.isArray(event.targets) || event.targets.some(target => boat.crew.includes(target))));
  const speedDelta = (Number(boat.speed) || 0) - (Number(before.speed) || 0);
  boat.speed = (Number(before.speed) || 0) + speedDelta * DUAL_TURRET_ACCELERATION_FACTOR;
  boat.speed = clamp(boat.speed, -DUAL_TURRET_REVERSE_SPEED, DUAL_TURRET_MAX_SPEED);
  const headingDelta = wrapDeg((Number(boat.heading) || 0) - (Number(before.heading) || 0));
  boat.heading = wrapDeg((Number(before.heading) || 0) + headingDelta * DUAL_TURRET_TURN_FACTOR);
  if (collision || boat.boundaryContact) return;
  const averageSpeed = ((Number(before.speed) || 0) + boat.speed) * 0.5;
  const middleHeading = wrapDeg((Number(before.heading) || 0) + headingDelta * DUAL_TURRET_TURN_FACTOR * 0.5);
  boat.x = (Number(before.x) || 0) + Math.sin(rad(middleHeading)) * averageSpeed * dt;
  boat.y = (Number(before.y) || 0) - Math.cos(rad(middleHeading)) * averageSpeed * dt;
  boat.x = clamp(boat.x, DUAL_TURRET_COLLISION_RADIUS, 420 - DUAL_TURRET_COLLISION_RADIUS);
  boat.y = clamp(boat.y, 76, 320 - DUAL_TURRET_COLLISION_RADIUS);
}

export function applyDualTurretBoatDamage(world, boat, rawDamage, details = {}) {
  if (!isDualTurretBoat(boat) || boat.sunk) return {damage: 0, absorbed: 0};
  let damage = Math.max(0, Number(rawDamage) || 0);
  const absorbed = Math.min(Number(boat.armor) || 0, damage * 0.72);
  boat.armor = Math.max(0, (Number(boat.armor) || 0) - absorbed);
  damage -= absorbed;
  boat.structuralHull = clamp((Number(boat.structuralHull) || 0) - damage, 0, Number(boat.maxStructuralHull) || DUAL_TURRET_HULL_POINTS);
  boat.hull = clamp(boat.structuralHull / boat.maxStructuralHull * 100, 0, 100);
  boat.leak = clamp((Number(boat.leak) || 0) + damage * 0.035, 0, 16);
  if (details.emit !== false) {
    emit(world, "dual-turret-boat-damaged", `Бронекатер получил попадание. Броня ${Math.round(boat.armor)}, корпус ${Math.round(boat.structuralHull)} из ${Math.round(boat.maxStructuralHull)}.`, boat.crew.filter(Number.isInteger), {
      sourcePlayer: details.sourcePlayer,
      boatId: boat.id,
      damage,
      absorbed,
      armor: boat.armor,
      structuralHull: boat.structuralHull,
      x: boat.x,
      y: boat.y,
    });
  }
  return {damage, absorbed};
}

function resolveDualBoatCollisions(world, boat, dt) {
  boat.dualCollisionCooldown = Math.max(0, Number(boat.dualCollisionCooldown) - dt);
  if (boat.sunk) return;
  for (const other of world.boats || []) {
    if (!other || other.id === boat.id || other.sunk || other.reserved) continue;
    const dx = (Number(other.x) || 0) - (Number(boat.x) || 0);
    const dy = (Number(other.y) || 0) - (Number(boat.y) || 0);
    const metres = Math.hypot(dx, dy);
    const minimum = DUAL_TURRET_COLLISION_RADIUS + 6;
    if (metres >= minimum || metres <= 0.001) continue;
    const nx = dx / metres;
    const ny = dy / metres;
    const overlap = minimum - metres;
    boat.x -= nx * overlap * 0.62;
    boat.y -= ny * overlap * 0.62;
    other.x += nx * overlap * 0.38;
    other.y += ny * overlap * 0.38;
    const impactSpeed = Math.abs((Number(boat.speed) || 0) - (Number(other.speed) || 0))
      + Math.abs(Number(boat.speed) || 0) * 0.25
      + Math.abs(Number(other.speed) || 0) * 0.25;
    if (impactSpeed <= 2 || boat.dualCollisionCooldown > 0 || Number(other.collisionCooldown) > 0) continue;
    const severity = collisionSeverity(impactSpeed);
    const dualImpact = applyDualTurretBoatDamage(world, boat, 15 * severity, {emit: false});
    const otherImpact = applyCollisionDamage(other, 15 * severity);
    boat.speed *= -0.18;
    other.speed *= -0.24;
    boat.dualCollisionCooldown = 1.25;
    other.collisionCooldown = 1.25;
    emit(world, "ram", `Столкновение с бронекатером. Его корпус потерял ${Math.round(dualImpact.damage)}, другая лодка — ${Math.round(otherImpact.damage)}.`, [0, 1], {
      boatId: boat.id,
      otherBoatId: other.id,
      x: (boat.x + other.x) / 2,
      y: (boat.y + other.y) / 2,
      strength: impactSpeed,
    });
  }
}

export function finishDualTurretBoatStep(world, context, dt) {
  const {boat, state, originals, saved, before} = context;
  restoreSaved(saved);
  const driverInput = Number.isInteger(boat.driver) ? (originals[boat.driver] || {}) : {};
  if (!driverInput.left && !driverInput.right) {
    boat.heading = before.heading;
    boat.rudder = 0;
  }
  syncStructuralHull(world, boat, before);
  applyMotionProfile(world, boat, before, dt);
  resolveDualBoatCollisions(world, boat, dt);
  syncCrew(world, boat);
  for (let index = 0; index < state.previousAction.length; index += 1) {
    state.previousAction[index] = Boolean(originals[index]?.action);
  }
  if (boat.sunk) {
    for (const playerIndex of [...boat.crew]) {
      if (Number.isInteger(playerIndex)) removeCrew(world, playerIndex, boat, {announce: false});
    }
  }
  return boat;
}
