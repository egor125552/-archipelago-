"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {
  handleDualTurretAudioEvent,
  preloadDualTurretAudio,
  stopDualTurretAudio,
  updateDualTurretEngine,
} from "./free-roam-dual-turret-audio.js?v=4";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=2";

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretPatchedV4) {
  prototype.__dualTurretPatchedV4 = true;
  const inheritedPreload = prototype.preload;
  const inheritedHandle = prototype.handleFreeEvent;
  const inheritedUpdate = prototype.updateWorld;
  const inheritedStopAll = prototype.stopAll;

  prototype.preload = async function preloadWithDualTurret() {
    const inherited = inheritedPreload.call(this);
    await Promise.allSettled([inherited, preloadDualTurretAudio(this)]);
  };

  prototype.handleFreeEvent = function handleFreeEventWithDualTurret(event, playerIndex) {
    if (handleDualTurretAudioEvent(this, event, playerIndex)) return;
    return inheritedHandle.call(this, event, playerIndex);
  };

  prototype.updateWorld = function updateWorldWithDualTurret(world, playerIndex) {
    const customBoat = (world?.boats || []).find(boat => boat?.audioProfile === "dual-turret");
    const originalStalled = customBoat?.engineStalled;
    // The common audio engine still receives the same boat state, but the
    // standard motor is muted for a boat that declares its own audio profile.
    if (customBoat) customBoat.engineStalled = true;
    let result;
    try {
      result = inheritedUpdate.call(this, world, playerIndex);
    } finally {
      if (customBoat) customBoat.engineStalled = originalStalled;
    }
    updateDualTurretEngine(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };

  prototype.stopAll = function stopAllWithDualTurret() {
    stopDualTurretAudio(this);
    return inheritedStopAll.call(this);
  };
}
