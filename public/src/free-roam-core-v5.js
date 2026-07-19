"use strict";

import * as base from "./free-roam-core-v4.js?v=35";

export const WORLD = Object.freeze({
  ...base.WORLD,
  landMinX: 118,
  landMaxX: 302,
  landMinY: 8,
  landMaxY: 76,
  towRestLength: 20,
  towMaximumLength: 35,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = value => value * Math.PI / 180;
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function inputFor(world, playerIndex) {
  return world.operationInputs?.[playerIndex] || world.inputs?.[playerIndex] || {};
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 160) world.events.splice(0, world.events.length - 160);
}

function ensureState(world) {
  if (!world) return world;
  world.version = Math.max(5, Number(world.version) || 0);
  world.freeRun ||= Array.from({length: world.players?.length || 2}, () => false);
  world.freeMeta ||= {
    boundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
    waterBoundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
    boatBoundaryAt: Array.from({length: world.boats?.length || 2}, () => -999),
  };
  world.freeMeta.boatBoundaryAt ||= Array.from({length: world.boats?.length || 2}, () => -999);
  while (world.freeRun.length < world.players.length) world.freeRun.push(false);
  while (world.freeMeta.boundaryAt.length < world.players.length) world.freeMeta.boundaryAt.push(-999);
  while (world.freeMeta.waterBoundaryAt.length < world.players.length) world.freeMeta.waterBoundaryAt.push(-999);
  while (world.freeMeta.boatBoundaryAt.length < world.boats.length) world.freeMeta.boatBoundaryAt.push(-999);
  for (const player of world.players || []) {
    if (typeof player.running !== "boolean") player.running = false;
    if (typeof player.airborne !== "boolean") player.airborne = false;
    if (!Number.isFinite(player.jumpHeight)) player.jumpHeight = 0;
    if (!Number.isFinite(player.jumpVelocity)) player.jumpVelocity = 0;
  }
  if (world.tow) ensureTow(world.tow, world);
  return world;
}

function ensureTow(tow, world) {
  if (!tow) return;
  const tower = world?.boats?.[tow.towerBoat];
  const towed = world?.boats?.[tow.towedBoat];
  const current = tower && towed ? distance(tower, towed) : WORLD.towRestLength;
  if (!Number.isFinite(tow.restLength)) tow.restLength = clamp(current, 18, 22);
  if (!Number.isFinite(tow.tension)) tow.tension = 0;
  if (!Number.isFinite(tow.strainTime)) tow.strainTime = 0;
  if (!Number.isFinite(tow.nextSoundAt)) tow.nextSoundAt = 0;
  if (!Number.isFinite(tow.lastDistance)) tow.lastDistance = current;
}

export function createFreeWorld() {
  return ensureState(base.createFreeWorld());
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureState(world);
  if (world.freeRun?.[playerIndex] != null) world.freeRun[playerIndex] = Boolean(nextInput?.run);
  base.setPlayerInput(world, playerIndex, nextInput);
}

export const drainEvents = base.drainEvents;

function suppressRepeatedAirJumps(world) {
  const restored = [];
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const input = world.inputs?.[index];
    if (!player?.airborne || !input?.jump) continue;
    restored.push([input, input.jump]);
    input.jump = false;
  }
  return () => {
    for (const [input, value] of restored) input.jump = value;
  };
}

function processRun(world, beforePlayers, dt) {
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const before = beforePlayers[index];
    const input = inputFor(world, index);
    const moving = Boolean(input.up || input.down || input.left || input.right);
    const shouldRun = player.mode === "foot" && moving && Boolean(world.freeRun[index]) && !player.airborne;
    const changed = shouldRun !== player.running;
    player.running = shouldRun;

    if (shouldRun && before?.mode === "foot") {
      const dx = player.x - before.x;
      const dy = player.y - before.y;
      player.x += dx * 0.72;
      player.y += dy * 0.72;
      player.stepTimer = Math.min(player.stepTimer, 0.26);
    }

    if (changed) {
      emit(world, shouldRun ? "run-start" : "run-stop", "", [index], {
        sourcePlayer: index,
        x: player.x,
        y: player.y,
      });
    }
  }
}

function processJumpArc(world, eventStart, dt) {
  const fresh = world.events.slice(eventStart);
  for (const event of fresh) {
    if (event.type !== "jump") continue;
    const playerIndex = Number(event.targets?.[0]);
    const player = world.players[playerIndex];
    if (!player || player.mode !== "foot" || player.airborne) continue;
    player.airborne = true;
    player.jumpHeight = 0.04;
    player.jumpVelocity = 5.8;
    event.sourcePlayer = playerIndex;
    event.x = player.x;
    event.y = player.y;
  }

  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    if (!player.airborne) continue;
    player.jumpHeight += player.jumpVelocity * dt;
    player.jumpVelocity -= 15.5 * dt;
    if (player.jumpHeight > 0 || player.jumpVelocity >= 0) continue;
    player.airborne = false;
    player.jumpHeight = 0;
    player.jumpVelocity = 0;
    emit(world, "landing", "", [0, 1], {
      sourcePlayer: index,
      x: player.x,
      y: player.y,
      movementPan: 0,
    });
  }
}

function boundaryPan(side) {
  if (side === "left") return -0.9;
  if (side === "right") return 0.9;
  return 0;
}

function processBoundaries(world) {
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    if (player.mode === "foot" && player.y > WORLD.shoreY + 3) {
      player.mode = "swim";
      player.running = false;
      emit(world, "splash", "Ты вошёл в воду.", [index], {
        sourcePlayer: index,
        x: player.x,
        y: player.y,
      });
    }
    if (player.mode === "foot") {
      const oldX = player.x;
      const oldY = player.y;
      player.x = clamp(player.x, WORLD.landMinX, WORLD.landMaxX);
      player.y = clamp(player.y, WORLD.landMinY, WORLD.landMaxY);
      if (oldX === player.x && oldY === player.y) continue;
      const side = oldX < WORLD.landMinX ? "left"
        : oldX > WORLD.landMaxX ? "right"
          : oldY < WORLD.landMinY ? "north" : "shore";
      if (world.time - world.freeMeta.boundaryAt[index] >= 0.8) {
        world.freeMeta.boundaryAt[index] = world.time;
        emit(world, "boundary", side === "shore" ? "Дальше вода. Здесь заканчивается береговая площадка." : "Край береговой площадки.", [index], {
          sourcePlayer: index,
          x: player.x,
          y: player.y,
          side,
          pan: boundaryPan(side),
        });
      }
    } else if (player.mode === "swim") {
      const atEdge = player.x <= 5.1 || player.x >= WORLD.width - 5.1 || player.y >= WORLD.height - 5.1;
      if (atEdge && world.time - world.freeMeta.waterBoundaryAt[index] >= 1.2) {
        world.freeMeta.waterBoundaryAt[index] = world.time;
        emit(world, "water-boundary", "Дальше открытая вода недоступна. Разворачивайся к бухте.", [index], {
          sourcePlayer: index,
          x: player.x,
          y: player.y,
        });
      }
    }
  }
}

function boatVelocity(boat) {
  const heading = rad(boat.heading);
  return {
    x: Math.sin(heading) * boat.speed,
    y: -Math.cos(heading) * boat.speed,
  };
}

function approachAngle(current, target, maximumChange) {
  return wrapDeg(current + clamp(wrapDeg(target - current), -maximumChange, maximumChange));
}

function detachTow(world, text) {
  const tow = world.tow;
  if (!tow) return;
  const tower = world.boats[tow.towerBoat];
  const towed = world.boats[tow.towedBoat];
  emit(world, "tow-detach", text, [0, 1], {
    x: ((tower?.x || 0) + (towed?.x || 0)) / 2,
    y: ((tower?.y || 0) + (towed?.y || 0)) / 2,
    tension: tow.tension,
  });
  world.tow = null;
}

function processTowPhysics(world, dt) {
  const tow = world.tow;
  if (!tow) return;
  ensureTow(tow, world);
  const tower = world.boats[tow.towerBoat];
  const towed = world.boats[tow.towedBoat];
  if (!tower || !towed || tower.sunk || towed.sunk) return;

  const dx = tower.x - towed.x;
  const dy = tower.y - towed.y;
  const metres = Math.hypot(dx, dy) || 0.001;
  const nx = dx / metres;
  const ny = dy / metres;
  const towerVelocity = boatVelocity(tower);
  const towedVelocity = boatVelocity(towed);
  const separationRate = (towerVelocity.x - towedVelocity.x) * nx + (towerVelocity.y - towedVelocity.y) * ny;
  const stretch = Math.max(0, metres - tow.restLength);
  const driver = towed.driver;
  const input = driver == null ? {} : inputFor(world, driver);
  const desiredHeading = Math.atan2(nx, -ny) * 180 / Math.PI;
  const headingError = Math.abs(wrapDeg(towed.heading - desiredHeading));
  const helping = Boolean(input.up) && headingError <= 48;
  const opposing = (Boolean(input.up) && headingError >= 82) || Boolean(input.down);

  const springForce = stretch * 0.92 + Math.max(0, separationRate) * 0.44;
  const force = Math.max(0, springForce + (opposing ? 7 : 0) - (helping ? 1.8 : 0));

  if (stretch > 0) {
    const correction = Math.min(2.4, stretch * 0.46);
    tower.x -= nx * correction * 0.18;
    tower.y -= ny * correction * 0.18;
    towed.x += nx * correction * 0.82;
    towed.y += ny * correction * 0.82;

    const targetFollowerSpeed = Math.max(0, tower.speed) * (helping ? 0.94 : 0.82);
    towed.speed += clamp(targetFollowerSpeed - towed.speed, -8 * dt, (helping ? 7 : 5.2) * dt);
    tower.speed *= Math.max(0.965, 1 - force * 0.0018);
  }

  if (!opposing && !input.left && !input.right && Math.abs(towed.speed) > 0.25) {
    const followRate = helping ? 58 : 42;
    towed.heading = approachAngle(towed.heading, desiredHeading, followRate * dt);
  }

  const targetTension = clamp(force / 8.4 + (opposing ? 0.55 : 0), 0, 1.45);
  tow.tension += (targetTension - tow.tension) * Math.min(1, dt * 5.2);
  if (tow.tension > 1.12) tow.strainTime += dt;
  else tow.strainTime = Math.max(0, tow.strainTime - dt * 1.8);

  const midpoint = {x: (tower.x + towed.x) / 2, y: (tower.y + towed.y) / 2};
  if (tow.tension > 0.24 && world.time >= tow.nextSoundAt) {
    tow.nextSoundAt = world.time + clamp(0.92 - tow.tension * 0.42, 0.34, 0.82);
    emit(world, tow.tension > 0.78 ? "tow-strain" : "tow-creak", tow.tension > 1.05 ? "Трос на пределе." : "", [0, 1], {
      tension: tow.tension,
      distance: metres,
      x: midpoint.x,
      y: midpoint.y,
    });
  }

  if (tow.strainTime > 2.8 || metres > WORLD.towMaximumLength) {
    detachTow(world, opposing
      ? "Трос лопнул: ведомая лодка долго тянула против буксира."
      : "Трос лопнул от чрезмерного растяжения.");
    return;
  }
  tow.lastDistance = metres;
}

function processBoatBoundaries(world) {
  const minX = WORLD.boatRadius + 0.05;
  const maxX = WORLD.width - WORLD.boatRadius - 0.05;
  const maxY = WORLD.height - WORLD.boatRadius - 0.05;
  for (let index = 0; index < world.boats.length; index += 1) {
    const boat = world.boats[index];
    if (!boat || boat.sunk) continue;
    const velocity = boatVelocity(boat);
    let side = null;
    if (boat.x <= minX && velocity.x < -0.08) {
      side = "left";
    } else if (boat.x >= maxX && velocity.x > 0.08) {
      side = "right";
    } else if (boat.y >= maxY && velocity.y > 0.08) {
      side = "open-water";
    }
    if (!side) {
      const clearLeft = boat.boundaryContact === "left" && boat.x > minX + 0.6;
      const clearRight = boat.boundaryContact === "right" && boat.x < maxX - 0.6;
      const clearOpenWater = boat.boundaryContact === "open-water" && boat.y < maxY - 0.6;
      if (clearLeft || clearRight || clearOpenWater) boat.boundaryContact = null;
      continue;
    }

    boat.x = clamp(boat.x, minX, maxX);
    boat.y = clamp(boat.y, WORLD.shoreY + 4, maxY);
    boat.speed = 0;
    boat.throttle = 0;
    boat.rudder = 0;
    boat.boundaryContact = side;
    if (world.time - world.freeMeta.boatBoundaryAt[index] < 1.1) continue;
    world.freeMeta.boatBoundaryAt[index] = world.time;
    const target = boat.driver ?? boat.owner;
    emit(world, "water-boundary", "Граница бухты. Дальше открытая вода недоступна; разворачивайся.", [target], {
      sourcePlayer: target,
      x: boat.x,
      y: boat.y,
      side,
      pan: side === "left" ? -0.9 : side === "right" ? 0.9 : 0,
    });
  }
}

function enrichMovementEvents(world, eventStart) {
  const fresh = world.events.slice(eventStart);
  for (const event of fresh) {
    if (!event || !["footstep", "swim-step"].includes(event.type)) continue;
    const source = Number(event.sourcePlayer ?? event.targets?.[0]);
    const player = world.players[source];
    if (!player) continue;
    event.running = Boolean(player.running);
    event.jumpHeight = Number(player.jumpHeight) || 0;
  }
}

export function stepFreeWorld(world, dt) {
  ensureState(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  const beforePlayers = world.players.map(player => ({x: player.x, y: player.y, mode: player.mode}));
  const eventStart = world.events?.length || 0;
  let preservedTow = null;

  if (world.tow) {
    ensureTow(world.tow, world);
    preservedTow = {
      tension: world.tow.tension,
      strainTime: world.tow.strainTime,
      restLength: world.tow.restLength,
      nextSoundAt: world.tow.nextSoundAt,
      lastDistance: world.tow.lastDistance,
    };
    // Let the legacy position correction run, but keep its tension accumulator
    // isolated from the upgraded spring/damper model below.
    world.tow.tension = 0;
    world.tow.strainTime = 0;
  }

  const restoreJumps = suppressRepeatedAirJumps(world);
  base.stepFreeWorld(world, safeDt);
  restoreJumps();

  if (world.tow && preservedTow) Object.assign(world.tow, preservedTow);
  processRun(world, beforePlayers, safeDt);
  processJumpArc(world, eventStart, safeDt);
  processBoundaries(world);
  processBoatBoundaries(world);
  processTowPhysics(world, safeDt);
  enrichMovementEvents(world, eventStart);
  return world;
}

export function playerStatus(world, playerIndex) {
  ensureState(world);
  const player = world.players[playerIndex];
  const details = [];
  if (player?.running) details.push("Ты бежишь.");
  if (player?.airborne) details.push("Ты в прыжке.");
  if (world.tow) details.push(`Натяжение троса ${Math.round(clamp(world.tow.tension / 1.45, 0, 1) * 100)} процентов.`);
  return `${base.playerStatus(world, playerIndex)} ${details.join(" ")}`.trim();
}

export function snapshotWorld(world) {
  ensureState(world);
  return base.snapshotWorld(world);
}
