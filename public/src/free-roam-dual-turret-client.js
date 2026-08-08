"use strict";

import "./vessel/stress-test-vessel-client.js?v=3";
import "./vessel/medium-crew-vessel-client.js?v=1";
import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=2";

// Legacy armored runtime mutation is gone. These side-effect imports are
// client adapters for architecture vessels: they only render audio/UI from the
// shared replicated vessel state and use the same FreeRoamAudio graph.
const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretUiPatchedV9) {
  prototype.__dualTurretUiPatchedV9 = true;
  const inheritedUpdate = prototype.updateWorld;
  prototype.updateWorld = function updateWorldWithDualTurretUi(world, playerIndex) {
    const result = inheritedUpdate.call(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };
}
