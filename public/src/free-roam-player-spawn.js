"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function placeJoiningPlayer(world, playerIndex) {
  const player = world.players[playerIndex];
  const anchorIndex = world.players.findIndex((candidate, index) => index !== playerIndex && world.freeActivities.presence[index]);
  const anchor = world.players[anchorIndex];
  const boat = world.boats.find(candidate => candidate.owner === playerIndex);
  if (!player || !anchor || !boat) return;

  if (anchor.mode === "foot") {
    player.mode = "foot";
    player.activeBoat = null;
    player.x = clamp(anchor.x + 5, 122, 298);
    player.y = clamp(anchor.y, 12, 70);
    player.heading = anchor.heading || 0;
    boat.driver = null;
    boat.x = clamp(anchor.x, 162, 258);
    boat.y = 84;
    boat.speed = 0;
    return;
  }

  const anchorBoat = Number.isInteger(anchor.activeBoat) ? world.boats[anchor.activeBoat] : null;
  if (!anchorBoat) return;
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
