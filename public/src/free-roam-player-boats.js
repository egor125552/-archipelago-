"use strict";

import {applyCollisionDamage, collisionSeverity} from "./collision-model.js";

const WORLD_WIDTH = 420;
const WORLD_HEIGHT = 320;
const SHORE_Y = 72;
const SHORE_MIN_X = 118;
const SHORE_MAX_X = 302;
const DEFAULT_RADIUS = 6;
const DEFAULT_CAPACITY = 1;
const CARGO_RANGE_BOAT = 12;
const CARGO_RANGE_FOOT = 4;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

export function ensurePlayerBoat(boat) {
  if (!boat) return null;
  if (!Number.isInteger(boat.crewCapacity)) boat.crewCapacity = Math.max(DEFAULT_CAPACITY, Number(boat.capacity) || DEFAULT_CAPACITY);
  boat.crewCapacity = Math.max(1, boat.crewCapacity);
  if (!Number.isFinite(Number(boat.collisionRadius))) boat.collisionRadius = DEFAULT_RADIUS;
  if (!Number.isFinite(Number(boat.boardingRange))) boat.boardingRange = 12;
  if (!Number.isInteger(boat.cargoCapacity)) boat.cargoCapacity = 5;
  boat.audioProfile ||= "standard";
  boat.label ||= boat.boatType === "dual-turret-patrol" ? "двухместный бронекатер" : "лодка";
  boat.crew = Array.isArray(boat.crew) ? boat.crew.slice(0, boat.crewCapacity) : [];
  while (boat.crew.length < boat.crewCapacity) boat.crew.push(null);
  if (boat.crewCapacity === 1 && Number.isInteger(boat.driver)) boat.crew[0] = boat.driver;
  if (boat.driver != null && !boat.crew.includes(boat.driver)) {
    const free = boat.crew.findIndex(value => !Number.isInteger(value));
    if (free >= 0) boat.crew[free] = boat.driver;
  }
  return boat;
}

export function boatOccupants(boat) {
  ensurePlayerBoat(boat);
  return [...new Set((boat?.crew || []).filter(Number.isInteger))];
}

export function boatTargets(boat) {
  const occupants = boatOccupants(boat);
  if (occupants.length) return occupants;
  const fallback = boat?.driver ?? boat?.owner;
  return Number.isInteger(fallback) ? [fallback] : [];
}

export function playerBoat(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  return ensurePlayerBoat(world?.boats?.[player.activeBoat]);
}

export function playerAboardBoat(world, playerIndex, boat = playerBoat(world, playerIndex)) {
  const player = world?.players?.[playerIndex];
  return Boolean(boat && player?.mode === "boat" && player.activeBoat === boat.id && boatOccupants(boat).includes(playerIndex));
}

function syncStations(boat) {
  if (!Array.isArray(boat?.turrets)) return;
  for (let index = 0; index < boat.turrets.length; index += 1) {
    boat.turrets[index].assignedPlayer = boat.crew?.[index] ?? null;
  }
}

function validPlayer(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  const presence = world?.freeActivities?.presence;
  return Boolean(
    player
    && player.mode !== "dead"
    && player.combat?.alive !== false
    && (!Array.isArray(presence) || presence[playerIndex])
  );
}

export function syncPlayerBoatCrew(world, boat) {
  ensurePlayerBoat(boat);
  if (!boat) return null;
  if (boat.sunk) {
    for (const playerIndex of boatOccupants(boat)) releasePlayerFromBoat(world, playerIndex, boat, {announce: false, forceWater: true});
    boat.driver = null;
    syncStations(boat);
    return boat;
  }
  for (const playerIndex of boatOccupants(boat)) {
    if (!validPlayer(world, playerIndex)) {
      releasePlayerFromBoat(world, playerIndex, boat, {announce: false});
      continue;
    }
    const player = world.players[playerIndex];
    player.mode = "boat";
    player.activeBoat = boat.id;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading;
  }
  if (!boatOccupants(boat).includes(boat.driver)) boat.driver = boatOccupants(boat)[0] ?? null;
  if (boat.crewCapacity === 1) boat.crew[0] = boat.driver;
  syncStations(boat);
  return boat;
}

export function assignPlayerToBoat(world, playerIndex, boat) {
  const player = world?.players?.[playerIndex];
  ensurePlayerBoat(boat);
  if (!player || !boat || boat.sunk || boat.reserved || !validPlayer(world, playerIndex)) return false;
  if (playerAboardBoat(world, playerIndex, boat)) return true;
  let seat = boat.crew.findIndex(value => value === playerIndex);
  if (seat < 0) seat = boat.crew.findIndex(value => !Number.isInteger(value));
  if (seat < 0) return false;
  boat.crew[seat] = playerIndex;
  if (!Number.isInteger(boat.driver)) boat.driver = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  boat.engineStalled = Boolean(boat.engineStalled && (
    Number(boat.fuel) <= 0.01
    || Number(boat.water) > 35
    || Number(boat.engineTemp) >= 92
    || boat.emergencyActive
  ));
  boat.prototypeIdleStall = false;
  syncStations(boat);
  emit(world, "enter", boat.crewCapacity > 1
    ? `${playerIndex === boat.driver ? "Ты занял место рулевого" : "Ты занял пассажирское место"} на ${boat.label}.`
    : boat.owner === playerIndex ? "Ты вернулся в свою лодку." : "Ты занял свободную лодку.", [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    seat,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

function nearShore(boat) {
  return Boolean(boat && boat.y <= SHORE_Y + 18 && boat.x >= SHORE_MIN_X && boat.x <= SHORE_MAX_X);
}

export function releasePlayerFromBoat(world, playerIndex, boat, {announce = true, forceWater = false} = {}) {
  const player = world?.players?.[playerIndex];
  ensurePlayerBoat(boat);
  if (!boat || !boat.crew.includes(playerIndex)) return false;
  boat.crew = boat.crew.map(value => value === playerIndex ? null : value);
  const wasDriver = boat.driver === playerIndex;
  if (wasDriver) {
    boat.driver = boatOccupants(boat)[0] ?? null;
    boat.throttle = 0;
    boat.rudder = 0;
    if (!Number.isInteger(boat.driver)) boat.speed = 0;
  }
  syncStations(boat);
  if (player && player.mode !== "dead") {
    const lands = !forceWater && nearShore(boat);
    player.mode = lands ? "foot" : "swim";
    player.activeBoat = null;
    player.x = clamp(Number(boat.x) + (playerIndex % 2 ? 7 : -7), 5, WORLD_WIDTH - 5);
    player.y = lands ? SHORE_Y - 7 : clamp(Number(boat.y) + 8, 5, WORLD_HEIGHT - 5);
    player.heading = boat.heading;
  }
  if (announce) emit(world, "exit", player?.mode === "foot" ? "Ты вышел на берег." : "Ты спрыгнул в воду.", [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    x: player?.x ?? boat.x,
    y: player?.y ?? boat.y,
  });
  return true;
}

function nearestBoat(world, point, maximum = Infinity, excludedId = null, requireSeat = false) {
  let selected = null;
  let best = maximum;
  for (const candidate of world?.boats || []) {
    if (!candidate || candidate.id === excludedId || candidate.sunk || candidate.reserved) continue;
    ensurePlayerBoat(candidate);
    if (requireSeat && boatOccupants(candidate).length >= candidate.crewCapacity) continue;
    const metres = distance(point, candidate);
    const allowed = Math.max(Number(candidate.boardingRange) || 12, maximum === Infinity ? 0 : maximum);
    if (metres > Math.min(best, allowed)) continue;
    best = metres;
    selected = candidate;
  }
  return {boat: selected, distance: best};
}

function nearbyActionableCargo(world, player) {
  if (player?.combat?.carriedCrate) return true;
  const maximum = player?.mode === "boat" ? CARGO_RANGE_BOAT : CARGO_RANGE_FOOT;
  return (world?.freeActivities?.crates || []).some(crate => crate?.state === "world" && distance(crate, player) <= maximum);
}

function runtimeState(world) {
  world.freePlayerBoats ||= {
    rawActionHeld: Array.from({length: world.players?.length || 2}, () => false),
    pendingActions: Array.from({length: world.players?.length || 2}, () => null),
  };
  const state = world.freePlayerBoats;
  while (state.rawActionHeld.length < world.players.length) state.rawActionHeld.push(false);
  while (state.pendingActions.length < world.players.length) state.pendingActions.push(null);
  return state;
}

export function capturePlayerBoatInput(world, playerIndex, nextInput) {
  const state = runtimeState(world);
  const pressed = Boolean(nextInput?.action);
  const rising = pressed && !state.rawActionHeld[playerIndex];
  state.rawActionHeld[playerIndex] = pressed;
  if (!rising) return false;
  const player = world?.players?.[playerIndex];
  if (!player || nearbyActionableCargo(world, player)) return false;
  const aboard = playerBoat(world, playerIndex);
  if (aboard && player.mode === "boat") {
    state.pendingActions[playerIndex] = {kind: "aboard", boatId: aboard.id};
    return true;
  }
  if (!["foot", "swim", "roof"].includes(player.mode)) return false;
  const sameRoofBoat = player.mode === "roof" ? world.boats?.[player.activeBoat] : null;
  const candidate = sameRoofBoat || nearestBoat(world, player, 22, null, true).boat;
  if (!candidate) return false;
  state.pendingActions[playerIndex] = {kind: "board", boatId: candidate.id};
  return true;
}

function detachTow(world, boat, playerIndex) {
  if (!world.tow || world.tow.towerBoat !== boat.id) return false;
  world.tow = null;
  emit(world, "tow-detach", "Буксировочный трос отцеплен.", [0, 1], {sourcePlayer: playerIndex, boatId: boat.id, x: boat.x, y: boat.y});
  return true;
}

function attachTow(world, boat, target, playerIndex) {
  if (!boat || !target || world.tow || boat.sunk || target.sunk) return false;
  world.tow = {towerBoat: boat.id, towedBoat: target.id, tension: 0, strainTime: 0};
  emit(world, "tow-attach", "Буксировочный трос закреплён.", [0, 1], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    otherBoatId: target.id,
    x: (boat.x + target.x) / 2,
    y: (boat.y + target.y) / 2,
  });
  return true;
}

function performAboardAction(world, playerIndex, boat) {
  if (!playerAboardBoat(world, playerIndex, boat)) return false;
  if (Math.abs(Number(boat.speed) || 0) > 0.35) {
    emit(world, "action-denied", "Чтобы покинуть лодку или работать с тросом, полностью остановись.", [playerIndex], {sourcePlayer: playerIndex, boatId: boat.id});
    return true;
  }
  if (boat.driver !== playerIndex) return releasePlayerFromBoat(world, playerIndex, boat);
  if (nearShore(boat)) return releasePlayerFromBoat(world, playerIndex, boat);
  if (detachTow(world, boat, playerIndex)) return true;
  const other = nearestBoat(world, boat, 24, boat.id, false);
  if (other.boat && Math.abs(Number(other.boat.speed) || 0) < 3.2) return attachTow(world, boat, other.boat, playerIndex);
  return releasePlayerFromBoat(world, playerIndex, boat, {forceWater: true});
}

function processPendingActions(world) {
  const state = runtimeState(world);
  for (let playerIndex = 0; playerIndex < state.pendingActions.length; playerIndex += 1) {
    const pending = state.pendingActions[playerIndex];
    if (!pending) continue;
    state.pendingActions[playerIndex] = null;
    const boat = ensurePlayerBoat(world.boats?.[pending.boatId]);
    if (!boat) continue;
    if (pending.kind === "aboard") performAboardAction(world, playerIndex, boat);
    else if (!assignPlayerToBoat(world, playerIndex, boat)) {
      emit(world, "action-denied", "На этой лодке нет свободного места.", [playerIndex], {sourcePlayer: playerIndex, boatId: boat.id});
    }
  }
}

function inputObjects(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function mergedInput(world, playerIndex) {
  return {
    ...(world?.freeActivities?.inputs?.[playerIndex] || {}),
    ...(world?.operationInputs?.[playerIndex] || {}),
    ...(world?.inputs?.[playerIndex] || {}),
  };
}

function setInput(world, playerIndex, key, value, saved) {
  for (const input of inputObjects(world, playerIndex)) {
    saved.push([input, key, input[key]]);
    input[key] = value;
  }
}

function beforeBoat(boat) {
  ensurePlayerBoat(boat);
  if (Number.isFinite(Number(boat.maxStructuralHull))) {
    boat.structuralHull = clamp(Number(boat.structuralHull) || 0, 0, Number(boat.maxStructuralHull));
    boat.hull = clamp(boat.structuralHull / Number(boat.maxStructuralHull) * 100, 0, 100);
  }
  return {
    hull: Number(boat.hull) || 0,
    structuralHull: Number(boat.structuralHull),
    armor: Number(boat.armor) || 0,
  };
}

export function preparePlayerBoatStep(world) {
  for (const boat of world?.boats || []) if (boat) syncPlayerBoatCrew(world, boat);
  processPendingActions(world);
  const saved = [];
  const originals = world.players.map((_, index) => mergedInput(world, index));
  const before = (world.boats || []).map(boat => boat ? beforeBoat(boat) : null);
  for (const boat of world.boats || []) {
    if (!boat) continue;
    ensurePlayerBoat(boat);
    const occupants = boatOccupants(boat);
    const driver = boat.driver;
    if (!Number.isInteger(driver)) continue;
    const pump = occupants.some(index => Boolean(originals[index]?.pump));
    const repair = occupants.some(index => Boolean(originals[index]?.repair));
    setInput(world, driver, "pump", pump, saved);
    setInput(world, driver, "repair", repair, saved);
    for (const passenger of occupants) {
      if (passenger === driver) continue;
      for (const key of ["up", "down", "left", "right"]) setInput(world, passenger, key, false, saved);
    }
  }
  return {saved, before};
}

function restoreInputs(saved) {
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    const [input, key, value] = saved[index];
    input[key] = value;
  }
}

function syncExtendedHull(boat, before) {
  const maximum = Number(boat?.maxStructuralHull);
  if (!boat || !before || !Number.isFinite(maximum) || maximum <= 0) return;
  const structuralChanged = Number(boat.structuralHull) !== Number(before.structuralHull);
  const compatibilityDelta = (Number(boat.hull) || 0) - Number(before.hull);
  if (!structuralChanged && compatibilityDelta < -0.0001) {
    const incoming = -compatibilityDelta;
    const absorbed = Math.min(Number(boat.armor) || 0, incoming * 0.72);
    boat.armor = Math.max(0, (Number(boat.armor) || 0) - absorbed);
    boat.structuralHull = clamp(Number(before.structuralHull) - (incoming - absorbed), 0, maximum);
  } else if (!structuralChanged && compatibilityDelta > 0.0001) {
    const repairPoints = compatibilityDelta / 100 * maximum;
    const armorMissing = Math.max(0, (Number(boat.armorMax) || 0) - (Number(boat.armor) || 0));
    const armorGain = Math.min(armorMissing, repairPoints * 0.45);
    boat.armor = (Number(boat.armor) || 0) + armorGain;
    boat.structuralHull = clamp(Number(before.structuralHull) + repairPoints - armorGain, 0, maximum);
  }
  boat.structuralHull = clamp(Number(boat.structuralHull) || 0, 0, maximum);
  boat.hull = clamp(boat.structuralHull / maximum * 100, 0, 100);
}

export function applyPlayerBoatDamage(world, boat, rawDamage, details = {}) {
  if (!boat || boat.sunk) return {damage: 0, absorbed: 0};
  const maximum = Number(boat.maxStructuralHull);
  if (!Number.isFinite(maximum) || maximum <= 0) {
    const result = applyCollisionDamage(boat, rawDamage);
    return {damage: result.damage, absorbed: result.absorbed || 0};
  }
  let damage = Math.max(0, Number(rawDamage) || 0);
  const absorbed = Math.min(Number(boat.armor) || 0, damage * 0.72);
  boat.armor = Math.max(0, (Number(boat.armor) || 0) - absorbed);
  damage -= absorbed;
  boat.structuralHull = clamp((Number(boat.structuralHull) || 0) - damage, 0, maximum);
  boat.hull = clamp(boat.structuralHull / maximum * 100, 0, 100);
  boat.leak = clamp((Number(boat.leak) || 0) + damage * 0.045, 0, 16);
  if (details.emit !== false) emit(world, "player-boat-damaged", `${boat.label} получил повреждение.`, boatTargets(boat), {
    boatId: boat.id,
    sourcePlayer: details.sourcePlayer,
    damage,
    absorbed,
    armor: boat.armor,
    structuralHull: boat.structuralHull,
    x: boat.x,
    y: boat.y,
  });
  return {damage, absorbed};
}

function resolveAdditionalCollisions(world, dt) {
  const boats = world.boats || [];
  for (const boat of boats) if (boat) boat.additionalCollisionCooldown = Math.max(0, (Number(boat.additionalCollisionCooldown) || 0) - dt);
  for (let left = 0; left < boats.length; left += 1) {
    for (let right = left + 1; right < boats.length; right += 1) {
      if (left < 2 && right < 2) continue;
      const a = boats[left];
      const b = boats[right];
      if (!a || !b || a.sunk || b.sunk || a.reserved || b.reserved) continue;
      ensurePlayerBoat(a);
      ensurePlayerBoat(b);
      const dx = Number(b.x) - Number(a.x);
      const dy = Number(b.y) - Number(a.y);
      const metres = Math.hypot(dx, dy);
      const minimum = Number(a.collisionRadius) + Number(b.collisionRadius);
      if (metres >= minimum || metres <= 0.001) continue;
      const nx = dx / metres;
      const ny = dy / metres;
      const overlap = minimum - metres;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;
      const impactSpeed = Math.abs((Number(a.speed) || 0) - (Number(b.speed) || 0)) + Math.abs(Number(a.speed) || 0) * 0.35 + Math.abs(Number(b.speed) || 0) * 0.35;
      if (impactSpeed <= 2 || a.additionalCollisionCooldown > 0 || b.additionalCollisionCooldown > 0) continue;
      const severity = collisionSeverity(impactSpeed);
      const impactA = applyPlayerBoatDamage(world, a, 15 * severity, {emit: false});
      const impactB = applyPlayerBoatDamage(world, b, 15 * severity, {emit: false});
      a.speed *= -0.22;
      b.speed *= -0.22;
      a.additionalCollisionCooldown = 1.25;
      b.additionalCollisionCooldown = 1.25;
      emit(world, "ram", `Столкновение лодок. Повреждение ${Math.round(impactA.damage)} и ${Math.round(impactB.damage)}.`, [...new Set([...boatTargets(a), ...boatTargets(b)])], {
        boatId: a.id,
        otherBoatId: b.id,
        strength: impactSpeed,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
    }
  }
}

function enrichBoatEvents(world, eventStart) {
  for (const event of (world.events || []).slice(eventStart)) {
    if (!event) continue;
    const boat = Number.isInteger(event.boatId) ? world.boats?.[event.boatId]
      : Number.isInteger(event.targetBoat) ? world.boats?.[event.targetBoat]
        : null;
    if (!boat) continue;
    const targets = boatTargets(boat);
    if (targets.length && ["pump-start", "hull-repair-start", "hull-repair-progress", "hull-repair-complete", "engine-water-restart", "engine-stall", "engine-flooded"].includes(event.type)) {
      event.targets = targets;
    }
  }
}

export function finishPlayerBoatStep(world, context, dt, eventStart = 0) {
  restoreInputs(context?.saved || []);
  for (let index = 0; index < (world.boats || []).length; index += 1) {
    const boat = world.boats[index];
    if (!boat) continue;
    syncExtendedHull(boat, context?.before?.[index]);
  }
  resolveAdditionalCollisions(world, Math.max(0, Number(dt) || 0));
  for (const boat of world.boats || []) if (boat) syncPlayerBoatCrew(world, boat);
  enrichBoatEvents(world, eventStart);
  return world;
}
