"use strict";

import {STRESS_TEST_VESSEL_SYSTEMS} from "./systems/stress-test-vessel-system.js?v=2";
import {MEDIUM_CREW_VESSEL_SYSTEMS} from "./systems/medium-crew-vessel-system.js?v=3";
import {VESSEL_MOUNTED_WEAPON_SYSTEMS} from "./systems/vessel-mounted-weapon-system.js?v=1";
import {VESSEL_ZONE_WATER_SYSTEMS} from "./systems/vessel-zone-water-system.js?v=2";
import {VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS} from "./systems/vessel-water-authority-persistence-system.js?v=1";
import {VESSEL_MODULE_REPAIR_SYSTEMS} from "./systems/vessel-module-repair-system.js?v=2";
import {VESSEL_MERCHANT_RECOVERY_SYSTEMS} from "./systems/vessel-merchant-recovery-system.js?v=1";
import {VESSEL_OWNERSHIP_SYSTEMS} from "./systems/vessel-ownership-system.js?v=1";
import {VESSEL_DECK_BOARDING_SYSTEMS} from "./systems/vessel-deck-boarding-system.js?v=1";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "./systems/vessel-deck-input-bridge-system.js?v=3";
import {VESSEL_DECK_LIFECYCLE_SYSTEMS} from "./systems/vessel-deck-lifecycle-system.js?v=1";
import {VESSEL_STATION_INPUT_SYSTEMS} from "./systems/vessel-station-input-system.js?v=1";
import {WALKABLE_VESSEL_SYSTEMS} from "./systems/walkable-vessel-system.js?v=1";
import {VESSEL_DECK_ACCESSIBILITY_SYSTEMS} from "./systems/vessel-deck-accessibility-system.js?v=1";
import {VESSEL_RESPAWN_SYSTEMS} from "./systems/vessel-respawn-system.js?v=1";

// Single explicit extension point for vessel-wide systems. New mechanics are
// registered here instead of adding concrete branches to the free-roam loop.
export function installVesselPlugins(registry) {
  for (const system of VESSEL_DECK_BOARDING_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_DECK_INPUT_BRIDGE_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_STATION_INPUT_SYSTEMS) registry.registerSystem(system);
  for (const system of WALKABLE_VESSEL_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_DECK_ACCESSIBILITY_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_DECK_LIFECYCLE_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_RESPAWN_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_OWNERSHIP_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_MERCHANT_RECOVERY_SYSTEMS) registry.registerSystem(system);
  for (const system of MEDIUM_CREW_VESSEL_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_MODULE_REPAIR_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_MOUNTED_WEAPON_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS) registry.registerSystem(system);
  for (const system of VESSEL_ZONE_WATER_SYSTEMS) registry.registerSystem(system);
  for (const system of STRESS_TEST_VESSEL_SYSTEMS) registry.registerSystem(system);
}
