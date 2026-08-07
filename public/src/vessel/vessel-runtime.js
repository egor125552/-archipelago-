"use strict";

import {createVesselRegistry} from "./vessel-registry.js";
import {STANDARD_BOAT_PRESET, LEGACY_BOAT_PRESET} from "./vessel-defaults.js";
import {syncLegacyVesselWorld, legacyVesselViews} from "./vessel-legacy-adapter.js";
import {installVesselPlugins} from "./vessel-plugin-manifest.js";

const registry = createVesselRegistry();
registry.registerPreset(STANDARD_BOAT_PRESET);
registry.registerPreset(LEGACY_BOAT_PRESET);
installVesselPlugins(registry);

export function vesselRegistry() {
  return registry;
}

export function attachVesselArchitecture(world) {
  syncLegacyVesselWorld(world);
  return world;
}

export function runVesselSystems(phase, context = {}) {
  const world = context.world;
  if (world) syncLegacyVesselWorld(world);
  registry.runSystems(phase, {
    ...context,
    registry,
    vessels: world ? legacyVesselViews(world) : [],
  });
  if (world) syncLegacyVesselWorld(world);
  return world;
}

export {syncLegacyVesselWorld, legacyVesselViews};
