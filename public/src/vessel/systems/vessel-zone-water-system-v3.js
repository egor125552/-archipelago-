"use strict";

import {VESSEL_ZONE_WATER_SYSTEMS as BASE_WATER_SYSTEMS} from "./vessel-zone-water-system.js?v=2";
import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

const beforeStep = BASE_WATER_SYSTEMS.find(system => system.phase === "before-step");
const afterStep = BASE_WATER_SYSTEMS.find(system => system.phase === "after-step");

function discardLegacyEngineStalls({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;

    // The v2 water authority already saved the vessel-owned engine state in its
    // before-step record. Any engineStalled value visible here was produced by
    // the legacy boat step while zonal water was masked out. Feeding that value
    // back into v2 makes a dry, healthy architectural vessel restart every 1.2s.
    // Real blockers are evaluated again by the authoritative water layer from
    // fuel, temperature, module health, flooding, emergency and sunk state.
    entry.boat.engineStalled = false;
  }
}

export const VESSEL_ZONE_WATER_SYSTEMS = Object.freeze([
  Object.freeze({
    ...beforeStep,
    id: "vessel-zone-water-authority-before-step-v3",
  }),
  Object.freeze({
    ...afterStep,
    id: "vessel-zone-water-authority-after-step-v3",
    run(context) {
      discardLegacyEngineStalls(context);
      return afterStep.run(context);
    },
  }),
]);
