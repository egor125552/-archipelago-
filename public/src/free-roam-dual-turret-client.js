"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {
  handleDualTurretAudioEvent,
  preloadDualTurretAudio,
  stopDualTurretAudio,
  updateDualTurretEngine,
  updateDualTurretProjectileAudio,
} from "./free-roam-dual-turret-audio.js";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js";

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretPatched) {
  prototype.__dualTurretPatched = true;
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
    const result = inheritedUpdate.call(this, world, playerIndex);
    updateDualTurretEngine(this, world, playerIndex);
    updateDualTurretProjectileAudio(this, world, playerIndex);
    updateDualTurretUi(world, playerIndex);
    return result;
  };

  prototype.stopAll = function stopAllWithDualTurret() {
    stopDualTurretAudio(this);
    return inheritedStopAll.call(this);
  };
}
