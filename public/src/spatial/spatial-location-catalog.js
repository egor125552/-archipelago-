"use strict";

export const SPATIAL_LOCATION_NAVIGATION_PREFIX = "location:";

export function spatialLocationNavigationTargetId(locationId) {
  const id = String(locationId || "").trim();
  return id ? `${SPATIAL_LOCATION_NAVIGATION_PREFIX}${id}` : null;
}

export function spatialLocationIdFromNavigationTargetId(targetId) {
  const value = String(targetId || "");
  if (!value.startsWith(SPATIAL_LOCATION_NAVIGATION_PREFIX)) return null;
  const id = value.slice(SPATIAL_LOCATION_NAVIGATION_PREFIX.length).trim();
  return id || null;
}

export function normalizeSpatialLocationCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || "").trim();
  const label = String(entry.label || "").trim();
  if (!id || !label) return null;
  const position = entry.position && typeof entry.position === "object"
    ? {
        x: Number(entry.position.x) || 0,
        y: Number(entry.position.y) || 0,
        z: Number(entry.position.z) || 0,
      }
    : null;
  return Object.freeze({
    id,
    label,
    navigationTargetId: spatialLocationNavigationTargetId(id),
    position: position ? Object.freeze(position) : null,
  });
}

export function spatialLocationMenuTargets(catalog) {
  const seen = new Set();
  const targets = [];
  for (const raw of Array.isArray(catalog) ? catalog : []) {
    const entry = normalizeSpatialLocationCatalogEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    targets.push(Object.freeze({
      id: `navigation-location-${entry.id}`,
      menuKind: "navigation",
      navigationTargetId: entry.navigationTargetId,
      locationId: entry.id,
      label: entry.label,
    }));
  }
  return Object.freeze(targets);
}
