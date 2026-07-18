"use strict";

export const BOARDING_ASSIST_RADIUS = 13;

const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function handleAssistedBoarding(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player || !["foot", "swim"].includes(player.mode)) return false;

  const candidates = (world.boats || [])
    .filter(boat => (
      !boat.sunk
      && boat.driver == null
      && distance(player, boat) <= BOARDING_ASSIST_RADIUS
    ))
    .sort((first, second) => {
      const ownership = Number(second.owner === playerIndex) - Number(first.owner === playerIndex);
      return ownership || distance(player, first) - distance(player, second);
    });
  const boat = candidates[0];
  if (!boat) return false;

  boat.driver = playerIndex;
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  emit(
    world,
    "enter",
    boat.owner === playerIndex
      ? "Ты автоматически подошёл и сел в свою лодку."
      : "Ты автоматически подошёл и сел в свободную чужую лодку.",
    [playerIndex],
    {sourcePlayer: playerIndex, boatId: boat.id, x: boat.x, y: boat.y},
  );
  return true;
}
