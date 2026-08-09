"use strict";

export const LEGACY_VESSEL_AUTHORITY = "legacy";

export function vesselSubsystemAuthority(definition, subsystem) {
  const id = String(subsystem || "").trim();
  if (!id) return LEGACY_VESSEL_AUTHORITY;
  const value = definition?.subsystemAuthority?.[id];
  return String(value || LEGACY_VESSEL_AUTHORITY);
}

export function vesselOwnsSubsystem(definition, subsystem) {
  return vesselSubsystemAuthority(definition, subsystem) !== LEGACY_VESSEL_AUTHORITY;
}

export function claimedVesselStation(entry, playerIndex) {
  if (!entry || !Number.isInteger(playerIndex)) return null;
  const claims = entry.instance?.interior?.claims || {};
  for (const deck of entry.definition?.decks || []) {
    for (const object of deck.objects || []) {
      if (object?.kind !== "station") continue;
      const resourceId = String(object.resourceId || object.id || "");
      if (!resourceId || claims[resourceId] !== playerIndex) continue;
      return {deck, object, resourceId};
    }
  }
  return null;
}

function moduleType(entry, moduleId) {
  return (entry?.definition?.modules || []).find(module => module.id === moduleId)?.type || null;
}

export function stationInputAuthorities(entry, playerIndex) {
  const station = claimedVesselStation(entry, playerIndex);
  if (!station) return new Set();
  const explicit = Array.isArray(station.object.inputAuthority)
    ? station.object.inputAuthority.map(value => String(value || "").trim()).filter(Boolean)
    : [];
  const result = new Set(explicit);

  // Backward-compatible inference for existing weapon stations. This lets the
  // authority rule fix every mounted-weapon station without concrete vessel IDs.
  if (moduleType(entry, station.object.controlsModule) === "mounted-weapon") result.add("attack");
  if (station.object.stationRole === "repair" && station.object.controlsModule) result.add("repair");
  return result;
}

export function stationOwnsInput(entry, playerIndex, field) {
  return stationInputAuthorities(entry, playerIndex).has(String(field || ""));
}
