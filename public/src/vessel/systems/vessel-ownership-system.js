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

function normalizeEnterEvent(world, event) {
  if (event?.type !== "enter") return;
  const playerIndex = eventPlayerIndex(event);
  if (!Number.isInteger(playerIndex)) return;
  const boat = eventBoat(world, event, playerIndex);
  if (!isManagedSingleSeatVessel(boat)) return;

  const previousOwner = Number.isInteger(boat.owner) ? boat.owner : null;
  const claimed = previousOwner == null;
  if (claimed) boat.owner = playerIndex;

  const owner = Number.isInteger(boat.owner) ? boat.owner : null;
  event.sourcePlayer = playerIndex;
  event.boatId = boat.id;
  event.boatType = boat.boatType || boat.vesselType || "standard";
  event.ownerPlayer = owner;
  event.ownedBoat = owner === playerIndex;
  event.claimedBoat = claimed;

  if (claimed) {
    event.text = `Ты занял свободное судно: ${vesselLabel(boat)}.`;
  } else if (owner === playerIndex) {
    event.text = `Ты вернулся в своё судно: ${vesselLabel(boat)}.`;
  } else if (Number.isInteger(owner)) {
    event.text = `Ты занял судно другого игрока: ${vesselLabel(boat)}.`;
  }
}

function normalizeBoardingOwnership({world, eventStart = 0} = {}) {
  if (!world) return;
  for (const event of (world.events || []).slice(eventStart)) normalizeEnterEvent(world, event);
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
