"use strict";

import {activateReservedBoat} from "./free-roam-reserve-boats.js";
import {requireSafeSpawn} from "./spatial/spatial-spawn-contract.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const LEGACY_SHORE_BOUNDS = Object.freeze({minX: 122, maxX: 298, minY: 12, maxY: 70});

export function freeRoamDockRespawnCandidates(playerIndex) {
  return [Object.freeze({
    id: `spawn.free-roam.dock.player-${playerIndex + 1}`,
    label: "Причал",
    position: Object.freeze({x: 210 + (playerIndex ? 8 : -8), y: 58, z: 0}),
    heading: 180,
    mode: "foot",
    data: Object.freeze({legacyWorld: "free-roam"}),
  })];
}

function isSafeLegacyShoreSpawn(spawn) {
  const {x, y, z} = spawn.position;
  return Number.isFinite(x)
    && Number.isFinite(y)
    && Number.isFinite(z)
    && x >= LEGACY_SHORE_BOUNDS.minX
    && x <= LEGACY_SHORE_BOUNDS.maxX
    && y >= LEGACY_SHORE_BOUNDS.minY
    && y <= LEGACY_SHORE_BOUNDS.maxY
    && Math.abs(z) <= 1e-9;
}

export function resolveFreeRoamDockRespawn(playerIndex) {
  return requireSafeSpawn(freeRoamDockRespawnCandidates(playerIndex), {isSafe: isSafeLegacyShoreSpawn});
}

export function applyFreeRoamDockRespawn(player, spawn) {
  if (!player || !spawn) throw new TypeError("player and spawn are required");
  player.mode = spawn.mode || "foot";
  player.activeBoat = null;
  player.x = spawn.position.x;
  player.y = spawn.position.y;
  player.heading = spawn.heading ?? 180;
  return player;
}

function placeFirstPlayer(player, boat, playerIndex) {
  const x = playerIndex === 0 ? 199 : 219;
  boat.x = x;
  boat.y = 158;
  boat.heading = 0;
  boat.speed = 0;
  boat.driver = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}

export function placeJoiningPlayer(world, playerIndex) {
  const player = world.players[playerIndex];
  const boat = world.boats.find(candidate => candidate.owner === playerIndex);
  if (!player || !boat) return;

  const activatedReserve = activateReservedBoat(boat, playerIndex);
  if (!activatedReserve && boat.connectionActivated) {
    // This boat already entered the room before. A reconnect must preserve its
    // exact position, cargo, damage and whether the player left it on shore.
    return;
  }
  if (!activatedReserve) boat.connectionActivated = true;

  const anchorIndex = world.players.findIndex((candidate, index) => (
    index !== playerIndex && world.freeActivities.presence[index]
  ));
  const anchor = world.players[anchorIndex];
  if (!anchor) {
    placeFirstPlayer(player, boat, playerIndex);
    return;
  }

  if (anchor.mode === "foot") {
    player.mode = "foot";
    player.activeBoat = null;
    player.x = clamp(anchor.x + 5, 122, 298);
    player.y = clamp(anchor.y, 12, 70);
    player.heading = anchor.heading || 0;
    boat.driver = null;
    boat.x = clamp(anchor.x, 162, 258);
    boat.y = 84;
    boat.heading = 0;
    boat.speed = 0;
    return;
  }

  const anchorBoat = Number.isInteger(anchor.activeBoat) ? world.boats[anchor.activeBoat] : null;
  if (!anchorBoat) {
    placeFirstPlayer(player, boat, playerIndex);
    return;
  }
  player.mode = "boat";
  player.activeBoat = boat.id;
  boat.driver = playerIndex;
  boat.x = clamp(anchorBoat.x + (anchorBoat.x < 210 ? 16 : -16), 12, 408);
  boat.y = clamp(anchorBoat.y + 4, 82, 306);
  boat.heading = anchorBoat.heading;
  boat.speed = 0;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}
