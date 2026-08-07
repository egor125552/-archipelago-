"use strict";

import {legacyVesselViews} from "./vessel-legacy-adapter.js";
import {nativeVesselForBoat, vesselRegistry} from "./vessel-runtime.js";

const PREFIX = "vessel:";

function boatById(world, boatId) {
  return Number.isInteger(boatId) ? world?.boats?.[boatId] || null : null;
}

function viewForBoat(world, boat) {
  if (!boat) return null;
  const legacy = legacyVesselViews(world).find(view => view.legacyBoatId === boat.id);
  const native = nativeVesselForBoat(world, boat.id);
  const definition = native ? vesselRegistry().resolveVesselType(native.instance.typeId) : null;
  const navigationTarget = definition
    ? definition.capabilities.sonarTarget === true
    : legacy?.navigationTarget === true;
  return {
    boat,
    label: definition?.presentation?.label || legacy?.label || String(boat.label || "судно"),
    navigationTarget,
  };
}

export function vesselNavigationTargetId(boatId) {
  return `${PREFIX}${Number(boatId)}`;
}

export function parseVesselNavigationTargetId(value) {
  const text = String(value || "");
  if (!text.startsWith(PREFIX)) return null;
  const id = Number(text.slice(PREFIX.length));
  return Number.isInteger(id) && id >= 0 ? id : null;
}

export function listVesselNavigationTargets(world, playerIndex) {
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat)
    ? world.players[playerIndex].activeBoat
    : null;
  const targets = [];
  for (const boat of world?.boats || []) {
    if (!boat || boat.sunk || boat.reserved || boat.id === currentBoatId) continue;
    const view = viewForBoat(world, boat);
    if (!view?.navigationTarget) continue;
    targets.push({
      id: vesselNavigationTargetId(boat.id),
      boatId: boat.id,
      label: view.label,
      x: Number(boat.x) || 0,
      y: Number(boat.y) || 0,
    });
  }
  return targets;
}

export function vesselNavigationTargetFromId(world, playerIndex, navigationTargetId) {
  const boatId = parseVesselNavigationTargetId(navigationTargetId);
  if (boatId == null) return null;
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat)
    ? world.players[playerIndex].activeBoat
    : null;
  if (boatId === currentBoatId) return null;
  const boat = boatById(world, boatId);
  if (!boat || boat.sunk || boat.reserved) return null;
  const view = viewForBoat(world, boat);
  if (!view?.navigationTarget) return null;
  return {
    id: vesselNavigationTargetId(boat.id),
    kind: "vessel",
    boatId: boat.id,
    label: view.label,
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
  };
}
