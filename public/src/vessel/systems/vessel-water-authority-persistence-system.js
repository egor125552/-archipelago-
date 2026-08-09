"use strict";

import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

const AUTHORITY_VERSION = 2;
const MARKER_FIELD = "floodAuthorityVersion";

function waterZoneStates(entry) {
  const result = [];
  for (const deck of entry?.definition?.decks || []) {
    for (const zone of deck.zones || []) {
      if (zone?.water?.enabled !== true) continue;
      const state = entry.instance?.zones?.[zone.id];
      if (state) result.push(state);
    }
  }
  return result;
}

function restoreAuthorityMarker({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!vesselOwnsSubsystem(entry?.definition, "flooding")) continue;
    const zones = waterZoneStates(entry);
    if (!zones.length || !zones.some(zone => Number(zone?.[MARKER_FIELD]) >= AUTHORITY_VERSION)) continue;
    entry.instance.interior ||= {};
    entry.instance.interior.waterBridge ||= {};
    entry.instance.interior.waterBridge.authorityVersion = AUTHORITY_VERSION;
    entry.instance.interior.waterBridge.initialized = true;
  }
}

function persistAuthorityMarker({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!vesselOwnsSubsystem(entry?.definition, "flooding")) continue;
    if (Number(entry.instance?.interior?.waterBridge?.authorityVersion) < AUTHORITY_VERSION) continue;
    for (const zone of waterZoneStates(entry)) zone[MARKER_FIELD] = AUTHORITY_VERSION;
  }
}

export const VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-water-authority-restore-before-step-v1",
    phase: "before-step",
    order: 45,
    run: restoreAuthorityMarker,
  }),
  Object.freeze({
    id: "vessel-water-authority-persist-after-step-v1",
    phase: "after-step",
    order: 13,
    run: persistAuthorityMarker,
  }),
]);
