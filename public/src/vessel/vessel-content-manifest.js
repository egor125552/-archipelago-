"use strict";

import {installCoreVesselModuleTypes} from "./modules/core-module-types.js?v=2";
import {installStressTestPhysicsModules} from "./physics/stress-test-physics.js?v=3";
import {installCurrentVesselTypes} from "./definitions/current-vessels.js?v=3";
import {installMediumCrewVesselType} from "./definitions/medium-crew-vessel-v2.js?v=2";

// Single explicit content extension point. Concrete module types, physics
// modules and vessel definitions are registered here; generic free-roam code
// never imports individual vessel implementations.
export function installVesselContent(registry) {
  installCoreVesselModuleTypes(registry);
  installStressTestPhysicsModules(registry);
  installCurrentVesselTypes(registry);
  installMediumCrewVesselType(registry);
}
