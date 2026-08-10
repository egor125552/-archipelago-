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

function rememberActiveArchitectureVessels({world, nativeVessels} = {}) {
  if (!world) return;
  const nativeBoatIds = new Set(
    (nativeVessels || [])
      .map(entry => entry?.boat?.id)
      .filter(Number.isInteger),
  );
  if (!nativeBoatIds.size) return;

  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    const activeBoat = player?.activeBoat;
    if (!Number.isInteger(activeBoat) || !nativeBoatIds.has(activeBoat)) continue;
    if (!world.boats?.[activeBoat]) continue;
    // lastBoatId is the shared merchant/service affinity used by the legacy
    // shop layer. Architecture vessels must participate in that same contract:
    // while a player is physically aboard one, it becomes their most recently
    // used vessel and remains the service target after they step ashore.
    player.lastBoatId = activeBoat;
  }
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

function normalizeBoardingOwnership(context = {}) {
  const {world, eventStart = 0} = context;
  if (!world) return;
  rememberActiveArchitectureVessels(context);
  for (const event of (world.events || []).slice(eventStart)) normalizeEnterEvent(world, event);
}

export const VESSEL_OWNERSHIP_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-ownership-after-step-v2",
    phase: "after-step",
    order: 10,
    run: normalizeBoardingOwnership,
  }),
]);
