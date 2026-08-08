"use strict";

import {STRESS_TEST_VESSEL_SYSTEMS} from "./systems/stress-test-vessel-system.js?v=1";
import {VESSEL_OWNERSHIP_SYSTEMS} from "./systems/vessel-ownership-system.js?v=1";
import {VESSEL_DECK_BOARDING_SYSTEMS} from "./systems/vessel-deck-boarding-system.js?v=1";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "./systems/vessel-deck-input-bridge-system.js?v=1";
import {WALKABLE_VESSEL_SYSTEMS} from "./systems/walkable-vessel-system.js?v=1";

// Single explicit extension point for vessel-wide systems. New mechanics are
// registered here instead of adding concrete branches to the free-roam loop.
export function installVesselPlugins(registry) {
  for (const system of VESSEL_DECK_BOARDING_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_DECK_INPUT_BRIDGE_SYSTEMS) registry.registerSystem(system);
  for (const system of WALKABLE_VESSEL_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_OWNERSHIP_SYSTEMS) registry.registerSystem(system);
  for (const system of STRESS_TEST_VESSEL_SYSTEMS) registry.registerSystem(system);
}
