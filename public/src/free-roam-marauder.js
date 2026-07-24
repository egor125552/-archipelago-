"use strict";

import {assignedPlayerForPursuer} from "./free-roam-pursuer-squad.js?v=32";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function createMarauder() {
  return {
    x: 362,
    y: 268,
    heading: 315,
    speed: 0,
    hull: 72,
    active: false,
    destroyed: false,
    respawnAt: 0,
    targetBoat: 0,
    ramCooldown: 0,
    stealCooldown: 0,
    recoveryRemaining: 0,
    cargo: [],
  };
}

export function ensureMarauder(world) {
  world.freeActivities.marauder ||= createMarauder();
  const marauder = world.freeActivities.marauder;
  marauder.cargo ||= [];
  if (!Number.isFinite(marauder.hull)) marauder.hull = 72;
  if (!Number.isFinite(marauder.speed)) marauder.speed = 0;
  if (!Number.isFinite(marauder.ramCooldown)) marauder.ramCooldown = 0;
  if (!Number.isFinite(marauder.stealCooldown)) marauder.stealCooldown = 0;
  if (!Number.isFinite(marauder.recoveryRemaining)) marauder.recoveryRemaining = 0;
  return marauder;
}

function cargoWeight(world, boat) {
  return (boat.cargo || []).reduce((sum, id) => {
    const crate = world.freeActivities.crates.find(candidate => candidate.id === id);
    return sum + (Number(crate?.weight) || 0);
  }, 0);
}

function chooseTargetBoat(world) {
  const presence = world.freeActivities.presence;
  let target = null;
  let value = -Infinity;
  for (const boat of world.boats || []) {
    if (boat.sunk) continue;
    const driverPresent = boat.driver != null && presence[boat.driver];
    const ownerPresent = presence[boat.owner];
    if (!driverPresent && !ownerPresent && !(boat.cargo || []).length) continue;
    const candidateValue = (boat.cargo || []).length * 100 + cargoWeight(world, boat) * 8 + (driverPresent ? 12 : 0);
    if (candidateValue > value) {
      value = candidateValue;
      target = boat;
    }
  }
  return target;
}

function steerToward(marauder, target, dt) {
  const dx = target.x - marauder.x;
  const dy = target.y - marauder.y;
  const desired = Math.atan2(dx, -dy) * 180 / Math.PI;
  const change = clamp(wrapDeg(desired - marauder.heading), -72 * dt, 72 * dt);
  marauder.heading = wrapDeg(marauder.heading + change);
  const targetSpeed = distance(marauder, target) < 22 ? 8 : 15.5;
  marauder.speed += clamp(targetSpeed - marauder.speed, -10 * dt, 7.5 * dt);
  const heading = marauder.heading * Math.PI / 180;
  marauder.x += Math.sin(heading) * marauder.speed * dt;
  marauder.y -= Math.cos(heading) * marauder.speed * dt;
  marauder.x = clamp(marauder.x, 7, 413);
  marauder.y = clamp(marauder.y, 78, 313);
}

function steerAway(marauder, target, dt) {
  const dx = marauder.x - target.x;
  const dy = marauder.y - target.y;
  const desired = Math.atan2(dx, -dy) * 180 / Math.PI;
  const change = clamp(wrapDeg(desired - marauder.heading), -105 * dt, 105 * dt);
  marauder.heading = wrapDeg(marauder.heading + change);
  marauder.speed += clamp(13 - marauder.speed, -12 * dt, 10 * dt);
  const heading = marauder.heading * Math.PI / 180;
  marauder.x += Math.sin(heading) * marauder.speed * dt;
  marauder.y -= Math.cos(heading) * marauder.speed * dt;
  marauder.x = clamp(marauder.x, 7, 413);
  marauder.y = clamp(marauder.y, 78, 313);
}

function separateBoats(boat, marauder, minimum = 16) {
  let dx = marauder.x - boat.x;
  let dy = marauder.y - boat.y;
  let metres = Math.hypot(dx, dy);
  if (metres < 0.001) {
    const heading = marauder.heading * Math.PI / 180;
    dx = Math.sin(heading);
    dy = -Math.cos(heading);
    metres = 1;
  }
  const push = Math.max(0, minimum - metres);
  const nx = dx / metres;
  const ny = dy / metres;
  boat.x = clamp(boat.x - nx * push * 0.28, 7, 413);
  boat.y = clamp(boat.y - ny * push * 0.28, 78, 313);
  marauder.x = clamp(marauder.x + nx * push * 0.72, 7, 413);
  marauder.y = clamp(marauder.y + ny * push * 0.72, 78, 313);
}

function stealCargo(world, marauder, boat) {
  if (marauder.stealCooldown > 0 || !(boat.cargo || []).length || distance(marauder, boat) > 10) return false;
  const id = boat.cargo.shift();
  const crate = world.freeActivities.crates.find(candidate => candidate.id === id);
  if (!crate) return false;
  crate.state = "marauder";
  crate.stowedBoat = null;
  crate.carriedBy = null;
  crate.x = marauder.x;
  crate.y = marauder.y;
  marauder.cargo.push(id);
  marauder.stealCooldown = 7;
  emit(world, "marauder-steal", "Мародёр сорвал ящик с лодки и уходит с грузом.", [0, 1], {
    crateId: id,
    kind: crate.kind,
    targetBoat: boat.id,
    x: marauder.x,
    y: marauder.y,
  });
  return true;
}

function ramBoat(world, marauder, boat) {
  if (marauder.ramCooldown > 0 || marauder.recoveryRemaining > 0 || Math.abs(marauder.speed) < 7 || distance(marauder, boat) > 11.5) return false;
  const impact = Math.max(6, Math.abs(marauder.speed - boat.speed) * 0.72);
  boat.hull = clamp(boat.hull - impact, 0.05, 100);
  boat.leak = clamp(boat.leak + impact * 0.055, 0, 16);
  boat.speed *= -0.24;
  marauder.speed *= -0.42;
  separateBoats(boat, marauder);
  marauder.ramCooldown = 3.4;
  marauder.recoveryRemaining = 3.2;
  emit(world, "pursuer-ram", `Катер-преследователь ударил лодку и отходит. Корпус ${Math.round(boat.hull)}.`, [boat.driver ?? boat.owner], {
    targetBoat: boat.id,
    strength: impact,
    damage: impact,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

export function releaseStolenCargo(world, marauder) {
  for (let index = 0; index < marauder.cargo.length; index += 1) {
    const crate = world.freeActivities.crates.find(candidate => candidate.id === marauder.cargo[index]);
    if (!crate) continue;
    crate.state = "world";
    crate.stowedBoat = null;
    crate.carriedBy = null;
    crate.x = clamp(marauder.x + index * 2.2, 8, 412);
    crate.y = clamp(marauder.y + index * 1.6, 82, 312);
  }
  marauder.cargo = [];
}

function destroyFromRam(world, marauder, playerIndex, helpers) {
  if (marauder.destroyed) return;
  releaseStolenCargo(world, marauder);
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  marauder.respawnAt = 0;
  emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен тараном. Остался редкий ящик.", [0, 1], {
    sourcePlayer: playerIndex,
    x: marauder.x,
    y: marauder.y,
  });
  helpers?.spawnRareCrate?.(world, marauder.x, marauder.y, "valuable", "pursuer");
  helpers?.onEnemyBoatDestroyed?.(world, marauder, playerIndex);
}

function resolvePlayerRams(world, marauder, helpers) {
  for (const boat of world.boats || []) {
    if (boat.sunk || distance(boat, marauder) > 11.5 || Math.abs(boat.speed) < 4.5 || marauder.ramCooldown > 0) continue;
    const effectiveHeading = wrapDeg(boat.heading + (boat.speed < 0 ? 180 : 0));
    const targetBearing = Math.atan2(marauder.x - boat.x, -(marauder.y - boat.y)) * 180 / Math.PI;
    if (Math.abs(wrapDeg(targetBearing - effectiveHeading)) > 70) continue;
    const impact = Math.max(10, Math.abs(boat.speed) * 1.8);
    marauder.hull = clamp(marauder.hull - impact, 0, 72);
    boat.hull = clamp(boat.hull - impact * 0.32, 0.05, 100);
    boat.speed *= -0.18;
    marauder.speed *= -0.55;
    separateBoats(boat, marauder);
    marauder.ramCooldown = 2.1;
    marauder.recoveryRemaining = 2.6;
    emit(world, "pursuer-hit", `Таран попал. Корпус преследователя ${Math.round(marauder.hull)}. Он отходит для нового захода.`, [boat.driver ?? boat.owner], {
      sourcePlayer: boat.driver ?? boat.owner,
      damage: impact,
      hull: marauder.hull,
      x: marauder.x,
      y: marauder.y,
    });
    if (marauder.hull <= 0) destroyFromRam(world, marauder, boat.driver ?? boat.owner, helpers);
    return true;
  }
  return false;
}

function respawnMarauder(world, marauder) {
  marauder.x = 362;
  marauder.y = 268;
  marauder.heading = 315;
  marauder.speed = 0;
  marauder.hull = 72;
  marauder.active = true;
  marauder.destroyed = false;
  marauder.respawnAt = 0;
  marauder.ramCooldown = 3;
  marauder.stealCooldown = 3;
  marauder.recoveryRemaining = 0;
  marauder.cargo = [];
  emit(world, "pursuer-return", "В бухту вернулся катер-преследователь.", [0, 1], {
    x: marauder.x,
    y: marauder.y,
  });
}

export function updateMarauder(world, dt, helpers = {}) {
  const marauder = ensureMarauder(world);
  if (marauder.destroyed || !marauder.active) {
    if (marauder.respawnAt > 0 && world.time >= marauder.respawnAt) respawnMarauder(world, marauder);
    return;
  }
  marauder.ramCooldown = Math.max(0, marauder.ramCooldown - dt);
  marauder.stealCooldown = Math.max(0, marauder.stealCooldown - dt);
  marauder.recoveryRemaining = Math.max(0, marauder.recoveryRemaining - dt);
  const assignedPlayerIndex = assignedPlayerForPursuer(world, marauder.id);
  const assignedPlayer = world.players?.[assignedPlayerIndex];
  if (assignedPlayer?.combat?.alive && ["foot", "swim"].includes(assignedPlayer.mode)) {
    steerToward(marauder, {
      x: assignedPlayer.x,
      y: assignedPlayer.mode === "foot" ? 78 : clamp(assignedPlayer.y, 78, 313),
    }, dt);
    return;
  }
  const target = chooseTargetBoat(world);
  if (!target) return;
  marauder.targetBoat = target.id;
  if (marauder.recoveryRemaining > 0) {
    steerAway(marauder, target, dt);
    return;
  }
  steerToward(marauder, target, dt);
  if (resolvePlayerRams(world, marauder, helpers)) return;
  stealCargo(world, marauder, target);
  ramBoat(world, marauder, target);
}
