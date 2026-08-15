"use strict";

function eventPlayerIndex(event) {
  if (Number.isInteger(event?.sourcePlayer)) return event.sourcePlayer;
  const target = event?.targets?.find(Number.isInteger);
  return Number.isInteger(target) ? target : null;
}

function eventBoat(world, event, playerIndex) {
  if (Number.isInteger(event?.boatId)) return world?.boats?.[event.boatId] || null;
  const activeBoat = Number.isInteger(playerIndex) ? world?.players?.[playerIndex]?.activeBoat : null;
  return Number.isInteger(activeBoat) ? world?.boats?.[activeBoat] || null : null;
}

function isManagedSingleSeatVessel(boat) {
  if (!boat?.vesselInstanceId) return false;
  return Math.max(1, Math.floor(Number(boat.crewCapacity) || 1)) === 1;
}

function vesselLabel(boat) {
  return String(boat?.label || "лодка").trim() || "лодка";
}

function claimActiveSingleSeatVessels(world) {
  for (let playerIndex = 0; playerIndex < (world?.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    const boatId = Number.isInteger(player?.activeBoat) ? player.activeBoat : null;
    const boat = boatId == null ? null : world.boats?.[boatId];
    if (!isManagedSingleSeatVessel(boat) || Number.isInteger(boat.owner)) continue;
    if (!["boat", "roof"].includes(player?.mode)) continue;
    boat.owner = playerIndex;
  }
}

function normalizeEnterEvent(world, event) {
  if (event?.type !== "enter") return;
  const playerIndex = eventPlayerIndex(event);
  if (!Number.isInteger(playerIndex)) return;
  const boat = eventBoat(world, event, playerIndex);
  if (!isManagedSingleSeatVessel(boat)) return;

  const eventAlreadyClaimed = event.claimedBoat === true;
  const previousOwner = Number.isInteger(boat.owner) ? boat.owner : null;
  const claimed = eventAlreadyClaimed || previousOwner == null;
  if (previousOwner == null) boat.owner = playerIndex;

  const owner = Number.isInteger(boat.owner) ? boat.owner : null;
  event.sourcePlayer = playerIndex;
  event.boatId = boat.id;
  event.boatType = boat.boatType || boat.vesselType || "standard";
  event.ownerPlayer = owner;
  event.ownedBoat = owner === playerIndex;
  event.claimedBoat = claimed && owner === playerIndex;

  if (event.claimedBoat) {
    event.text = `Ты занял свободное судно: ${vesselLabel(boat)}.`;
  } else if (owner === playerIndex) {
    event.text = `Ты вернулся в своё судно: ${vesselLabel(boat)}.`;
  } else if (Number.isInteger(owner)) {
    event.text = `Ты занял судно другого игрока: ${vesselLabel(boat)}.`;
  }
}

function normalizeBoardingOwnership({world, eventStart = 0} = {}) {
  if (!world) return;
  const events = (world.events || []).slice(eventStart);
  for (const event of events) {
    const playerIndex = eventPlayerIndex(event);
    const boat = eventBoat(world, event, playerIndex);
    if (event?.type === "enter" && isManagedSingleSeatVessel(boat) && !Number.isInteger(boat.owner)) {
      event.claimedBoat = true;
    }
  }
  claimActiveSingleSeatVessels(world);
  for (const event of events) normalizeEnterEvent(world, event);
}

export const VESSEL_OWNERSHIP_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-ownership-after-input-v1",
    phase: "after-input",
    order: 10,
    run: normalizeBoardingOwnership,
  }),
  Object.freeze({
    id: "vessel-ownership-after-step-v1",
    phase: "after-step",
    order: 10,
    run: normalizeBoardingOwnership,
  }),
]);
