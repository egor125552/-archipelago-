"use strict";

const RESERVE_X = -1_000;
const RESERVE_Y = -1_000;

export function reserveUnconnectedBoats(world) {
  if (!world) return world;
  world.tow = null;
  for (const boat of world.boats || []) {
    if (!boat) continue;
    boat.reserved = true;
    boat.driver = null;
    boat.sunk = true;
    boat.speed = 0;
    boat.throttle = 0;
    boat.rudder = 0;
    boat.pumpActive = false;
    boat.refuelActive = false;
    boat.engineServiceActive = false;
    boat.x = RESERVE_X - (Number(boat.id) || 0) * 20;
    boat.y = RESERVE_Y;

    const player = world.players?.[boat.owner];
    if (!player) continue;
    player.mode = "waiting";
    player.activeBoat = null;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading || 0;
  }
  return world;
}

export function activateReservedBoat(boat, playerIndex) {
  if (!boat?.reserved) return false;
  boat.reserved = false;
  boat.sunk = false;
  boat.driver = playerIndex;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.pumpActive = false;
  boat.refuelActive = false;
  boat.refuelProgress = 0;
  boat.engineServiceActive = false;
  boat.engineServiceProgress = 0;
  boat.boundaryContact = null;
  return true;
}
