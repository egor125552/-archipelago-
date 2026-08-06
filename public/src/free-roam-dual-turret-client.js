"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {
  handleDualTurretAudioEvent,
  preloadDualTurretAudio,
} from "./free-roam-dual-turret-audio.js?v=4";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=1";

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretPatched) {
  prototype.__dualTurretPatched = true;
  const inheritedPreload = prototype.preload;
  const inheritedHandle = prototype.handleFreeEvent;
  const inheritedUpdate = prototype.updateWorld;

  prototype.preload = async function preloadWithDualTurret() {
    const inherited = inheritedPreload.call(this);
    await Promise.allSettled([inherited, preloadDualTurretAudio(this)]);
  };

  prototype.handleFreeEvent = function handleFreeEventWithDualTurret(event, playerIndex) {
    if (handleDualTurretAudioEvent(this, event, playerIndex)) return;
    return inheritedHandle.call(this, event, playerIndex);
  };

  prototype.updateWorld = function updateWorldWithDualTurret(world, playerIndex) {
    const result = inheritedUpdate.call(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };
}
