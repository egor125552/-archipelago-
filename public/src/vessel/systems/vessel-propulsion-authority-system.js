"use strict";

import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

function propulsionModule(entry) {
  return entry?.instance?.modules?.engine || null;
}

function legacyStallIsStillAuthoritative(entry) {
  const boat = entry?.boat;
  const engine = propulsionModule(entry);
  const waterBridge = entry?.instance?.interior?.waterBridge;
  if (!boat) return true;

  return Boolean(
    boat.sunk
    || boat.emergencyActive
    || boat.refuelActive
    || boat.engineServiceActive
    || (Number(boat.fuel) || 0) <= 0.01
    || Number(boat.engineTemp || 0) >= 104
    || (engine && ((Number(engine.health) || 0) <= 0 || engine.enabled === false))
    || waterBridge?.floodDisabledModules?.engine
  );
}

function discardLegacyPropulsionStalls({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "propulsion")) continue;
    if (legacyStallIsStillAuthoritative(entry)) continue;

    // The legacy free-roam boat loop still runs for compatibility, but a vessel
    // that explicitly owns propulsion through modules must not accept the old
    // loop's transient engineStalled result as a second propulsion authority.
    // The zonal water system already captured the authoritative pre-step stall
    // before the legacy loop ran; clearing only the legacy result here lets that
    // captured state drive the single 1.2 s restart lifecycle exactly once.
    entry.boat.engineStalled = false;
  }
}

export const VESSEL_PROPULSION_AUTHORITY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-propulsion-authority-after-step-v1",
    phase: "after-step",
    order: 11,
    run: discardLegacyPropulsionStalls,
  }),
]);
