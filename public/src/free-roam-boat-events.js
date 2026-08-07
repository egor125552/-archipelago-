"use strict";

export function activeBoatIds(world) {
  return (world?.players || []).map(player => Number.isInteger(player?.activeBoat) ? player.activeBoat : null);
}

function playerIndexForEvent(event) {
  if (Number.isInteger(event?.sourcePlayer)) return event.sourcePlayer;
  const target = event?.targets?.find(Number.isInteger);
  return Number.isInteger(target) ? target : null;
}

function boatForTransitionId(world, boatId) {
  if (!Number.isInteger(boatId)) return null;
  const boats = world?.boats || [];
  return boats.find(candidate => candidate?.id === boatId) || boats[boatId] || null;
}

export function attachBoatTransitionMetadata(world, eventStart = 0, previousBoatIds = []) {
  for (const event of (world?.events || []).slice(eventStart)) {
    if (!event || !["enter", "exit"].includes(event.type)) continue;
    const playerIndex = playerIndexForEvent(event);
    if (!Number.isInteger(playerIndex)) continue;
    const player = world.players?.[playerIndex];
    const inferredBoatId = event.type === "exit"
      ? previousBoatIds?.[playerIndex]
      : player?.activeBoat;
    const boatId = Number.isInteger(event.boatId) ? event.boatId : inferredBoatId;
    const boat = boatForTransitionId(world, boatId);
    if (!boat) continue;

    event.boatId = boat.id;
    event.boatType = boat.boatType || "standard";
    event.boatLabel = boat.label || "лодка";
    event.audioProfile = boat.audioProfile || "standard";
    if (player) player.lastBoatId = boat.id;
  }
  return world;
}
