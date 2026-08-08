"use strict";

import "./vessel/stress-test-vessel-client.js?v=2";
import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=2";

// The legacy armored runtime mutation is gone. This hook only paints the
// patrol's extra hull, armor and mounted-weapon fields after the common
// FreeRoamAudio update has consumed the same world snapshot as every boat.
// The side-effect import above is the temporary client bootstrap for the
// architecture stress-test vessel; its engine still routes through the shared
// FreeRoamAudio master/compressor rather than creating a parallel audio engine.
const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretUiPatchedV7) {
  prototype.__dualTurretUiPatchedV7 = true;
  const inheritedUpdate = prototype.updateWorld;
  prototype.updateWorld = function updateWorldWithDualTurretUi(world, playerIndex) {
    const result = inheritedUpdate.call(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };
}
