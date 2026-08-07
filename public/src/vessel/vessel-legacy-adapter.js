"use strict";

import {assertId} from "./vessel-contract.js";

const worldViews = new WeakMap();
const LEGACY_NAVIGATION_TARGET_TYPES = new Set(["dual-turret-patrol"]);

function legacyTypeId(boat) {
  const raw = String(boat?.boatType || boat?.vesselType || boat?.type || "legacy-boat").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "legacy-boat";
}

function legacyInstanceId(boat, typeId, legacyBoatId) {
  const stored = String(boat?.vesselInstanceId || "").trim();
  return assertId(stored || `legacy:${legacyBoatId ?? typeId}`, "legacy vessel instance id");
}

function viewKey(boat) {
  const stable = String(boat?.vesselInstanceId || "").trim();
  if (stable) return `instance:${stable}`;
  return Number.isInteger(boat?.id) ? `boat:${boat.id}` : boat;
}

function createView(boat) {
  const legacyBoatId = Number.isInteger(boat?.id) ? boat.id : null;
  const typeId = legacyTypeId(boat);
  return Object.freeze({
    instanceId: legacyInstanceId(boat, typeId, legacyBoatId),
    typeId,
    legacyBoatId,
    legacy: true,
    source: boat,
    get label() { return String(boat?.label || "судно"); },
    get navigationTarget() { return boat?.navigationTarget === true || LEGACY_NAVIGATION_TARGET_TYPES.has(typeId); },
    get x() { return Number(boat?.x) || 0; },
    get y() { return Number(boat?.y) || 0; },
    get heading() { return Number(boat?.heading) || 0; },
    get speed() { return Number(boat?.speed) || 0; },
    get physicsProfile() { return boat?.physicsProfile || null; },
  });
}

export function syncLegacyVesselWorld(world) {
  if (!world || !Array.isArray(world.boats)) return [];
  let views = worldViews.get(world);
  if (!views) {
    views = new Map();
    worldViews.set(world, views);
  }
  const present = new Set();
  for (const boat of world.boats) {
    if (!boat) continue;
    const key = viewKey(boat);
    present.add(key);
    const previous = views.get(key);
    if (!previous || previous.source !== boat || previous.instanceId !== legacyInstanceId(boat, legacyTypeId(boat), boat.id)) {
      views.set(key, createView(boat));
    }
  }
  for (const key of views.keys()) if (!present.has(key)) views.delete(key);
  return [...views.values()];
}

export function legacyVesselViews(world) {
  return syncLegacyVesselWorld(world);
}

export function legacyVesselViewForBoat(world, boat) {
  if (!boat) return null;
  syncLegacyVesselWorld(world);
  return worldViews.get(world)?.get(viewKey(boat)) || null;
}
