"use strict";

import {releaseVesselOccupantResources} from "../vessel-deck-runtime.js";

function releaseOrphanedClaims({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!entry?.definition?.deckArchitecture?.enabled) continue;
    const occupants = entry.instance?.occupants || {};
    const owners = new Set(Object.values(entry.instance?.interior?.claims || {}).filter(Number.isInteger));
    for (const owner of owners) {
      if (!occupants[owner]) releaseVesselOccupantResources(entry.instance, owner);
    }
  }
}

export const VESSEL_DECK_LIFECYCLE_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-deck-lifecycle-after-step-v1", phase: "after-step", order: 8, run: releaseOrphanedClaims}),
]);
