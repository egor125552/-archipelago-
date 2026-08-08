"use strict";

import {STRESS_TEST_VESSEL_SYSTEMS} from "./systems/stress-test-vessel-system.js?v=1";

// Single explicit extension point for vessel-wide systems. New mechanics are
// registered here instead of adding concrete branches to the free-roam loop.
export function installVesselPlugins(registry) {
  for (const system of STRESS_TEST_VESSEL_SYSTEMS) registry.registerSystem(system);
}
