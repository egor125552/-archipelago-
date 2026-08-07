"use strict";

import {installCoreVesselModuleTypes} from "./modules/core-module-types.js";
import {installCurrentVesselTypes} from "./definitions/current-vessels.js";

// Single explicit content extension point. Concrete module types and vessel
// definitions are registered here; generic free-roam code never imports them.
export function installVesselContent(registry) {
  installCoreVesselModuleTypes(registry);
  installCurrentVesselTypes(registry);
}
