"use strict";

import {VesselContractError, assertId} from "./vessel-contract.js";

const rad = degrees => Number(degrees || 0) * Math.PI / 180;
const deg = radians => Number(radians || 0) * 180 / Math.PI;
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function deckFor(definition, deckId) {
  return (definition?.decks || []).find(deck => deck.id === deckId) || null;
}

function zoneFor(deck, zoneId) {
  return (deck?.zones || []).find(zone => zone.id === zoneId) || null;
}

export function vesselLocalToWorld(boat, localPosition) {
  const heading = rad(boat?.heading);
  const x = Number(localPosition?.x) || 0;
  const y = Number(localPosition?.y) || 0;
  return Object.freeze({
    x: (Number(boat?.x) || 0) + x * Math.cos(heading) + y * Math.sin(heading),
    y: (Number(boat?.y) || 0) + x * Math.sin(heading) - y * Math.cos(heading),
  });
}

export function worldToVesselLocal(boat, worldPosition) {
  const dx = (Number(worldPosition?.x) || 0) - (Number(boat?.x) || 0);
  const dy = (Number(worldPosition?.y) || 0) - (Number(boat?.y) || 0);
  const heading = rad(boat?.heading);
  return Object.freeze({
    x: dx * Math.cos(heading) + dy * Math.sin(heading),
    y: dx * Math.sin(heading) - dy * Math.cos(heading),
  });
}

export function setVesselOccupantPosition(definition, runtime, playerIndex, position) {
  if (!definition?.capabilities?.walkableInterior) throw new VesselContractError(`vessel ${definition?.id || "unknown"} has no walkable interior`);
  if (!Number.isInteger(playerIndex) || playerIndex < 0) throw new VesselContractError("playerIndex must be a non-negative integer");
  const deckId = assertId(position?.deckId, "occupant deckId");
  const deck = deckFor(definition, deckId);
  if (!deck) throw new VesselContractError(`unknown deck ${deckId}`);
  const zoneId = position?.zoneId == null ? null : assertId(position.zoneId, "occupant zoneId");
  if (zoneId && !zoneFor(deck, zoneId)) throw new VesselContractError(`unknown zone ${zoneId} on deck ${deckId}`);
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new VesselContractError("occupant local position needs finite x/y");
  runtime.occupants ||= {};
  runtime.occupants[playerIndex] = {deckId, zoneId, x, y};
  return runtime.occupants[playerIndex];
}

export function clearVesselOccupantPosition(runtime, playerIndex) {
  if (!runtime?.occupants) return false;
  const existed = Object.prototype.hasOwnProperty.call(runtime.occupants, playerIndex);
  delete runtime.occupants[playerIndex];
  return existed;
}

export function syncWalkableVesselOccupants(world, definition, runtime, boat) {
  if (!definition?.capabilities?.walkableInterior || !runtime?.occupants) return;
  for (const [rawIndex, local] of Object.entries(runtime.occupants)) {
    const player = world?.players?.[Number(rawIndex)];
    if (!player || player.activeBoat !== boat?.id) continue;
    const worldPosition = vesselLocalToWorld(boat, local);
    player.x = worldPosition.x;
    player.y = worldPosition.y;
    player.heading = Number(boat.heading) || 0;
  }
}

export function findVesselLandmark(definition, landmarkId) {
  const id = assertId(landmarkId, "landmark id");
  for (const deck of definition?.decks || []) {
    const landmark = deck.landmarks.find(item => item.id === id);
    if (landmark) return {deck, landmark};
  }
  return null;
}

function directionLabel(relativeDegrees) {
  const angle = wrap(relativeDegrees);
  if (Math.abs(angle) < 22.5) return "впереди";
  if (Math.abs(angle) > 157.5) return "сзади";
  if (angle > 0 && angle < 67.5) return "впереди справа";
  if (angle >= 67.5 && angle <= 112.5) return "справа";
  if (angle > 112.5) return "сзади справа";
  if (angle < 0 && angle > -67.5) return "впереди слева";
  if (angle <= -67.5 && angle >= -112.5) return "слева";
  return "сзади слева";
}

export function vesselLandmarkGuidance(definition, runtime, playerIndex, landmarkId) {
  const local = runtime?.occupants?.[playerIndex];
  if (!local) return null;
  const found = findVesselLandmark(definition, landmarkId);
  if (!found) return null;
  const dx = found.landmark.position.x - local.x;
  const dy = found.landmark.position.y - local.y;
  const distance = Math.hypot(dx, dy);
  // Local +Y is the vessel's forward axis; atan2(x, y) gives right-positive relative bearing.
  const relativeBearing = wrap(deg(Math.atan2(dx, dy)));
  return Object.freeze({
    landmarkId: found.landmark.id,
    label: found.landmark.label,
    deckId: found.deck.id,
    deckLabel: found.deck.label,
    sameDeck: local.deckId === found.deck.id,
    distance,
    relativeBearing,
    direction: directionLabel(relativeBearing),
    text: local.deckId === found.deck.id
      ? `${found.landmark.label}: ${Math.round(distance)} м, ${directionLabel(relativeBearing)}.`
      : `${found.landmark.label}: ${found.deck.label}.`,
  });
}
