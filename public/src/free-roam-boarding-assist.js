"use strict";

export const BOARDING_ASSIST_RADIUS = 13;

const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function assignDriverSeat(boat, playerIndex) {
  if (!Array.isArray(boat.crew)) return;
  const capacity = Math.max(1, Math.floor(Number(boat.crewCapacity) || boat.crew.length || 1));
  while (boat.crew.length < capacity) boat.crew.push(null);
  if (boat.crew.includes(playerIndex)) return;
  const seat = boat.crew.findIndex(value => !Number.isInteger(value));
  if (seat >= 0) boat.crew[seat] = playerIndex;
}

export function handleAssistedBoarding(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player || !["foot", "swim"].includes(player.mode)) return false;

  const candidates = (world.boats || [])
    .filter(boat => (
      boat
      && !boat.sunk
      && !boat.reserved
      && boat.driver == null
      && distance(player, boat) <= (Number(boat.boardingRange) || BOARDING_ASSIST_RADIUS)
    ))
    .sort((first, second) => {
      const ownership = Number(second.owner === playerIndex) - Number(first.owner === playerIndex);
      return ownership || distance(player, first) - distance(player, second);
    });
  const boat = candidates[0];
  if (!boat) return false;

  boat.driver = playerIndex;
  assignDriverSeat(boat, playerIndex);
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
      : `Ты автоматически подошёл и сел в ${boat.label || "свободную лодку"}.`,
    [playerIndex],
    {sourcePlayer: playerIndex, boatId: boat.id, x: boat.x, y: boat.y},
  );
  return true;
}
