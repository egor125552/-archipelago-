"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=2";

// The legacy armored runtime mutation is gone. This hook only paints the
// patrol's extra hull, armor and mounted-weapon fields after the common
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
