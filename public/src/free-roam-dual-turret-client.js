"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=2";

// Legacy runtime mutation removed: customBoat.engineStalled = true
// The armored patrol has no second audio or physics runtime. This hook only
// paints its extra hull, armor and mounted-weapon fields after the common
// FreeRoamAudio update has consumed the same world snapshot as every boat.
const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretUiPatchedV6) {
  prototype.__dualTurretUiPatchedV6 = true;
  const inheritedUpdate = prototype.updateWorld;
  prototype.updateWorld = function updateWorldWithDualTurretUi(world, playerIndex) {
    const result = inheritedUpdate.call(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };
}
