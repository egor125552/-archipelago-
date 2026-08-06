"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {
  handleDualTurretAudioEvent,
  preloadDualTurretAudio,
  stopDualTurretAudio,
  updateDualTurretEngine,
  updateDualTurretProjectileAudio,
} from "./free-roam-dual-turret-audio.js?v=2";
import {updateDualTurretUi} from "./free-roam-dual-turret-ui.js?v=1";

const isDualTurretBoat = boat => boat?.boatType === "dual-turret-patrol";

function localDualBoat(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  return player && ["boat", "roof"].includes(player.mode)
    ? world.boats?.[player.activeBoat]
    : null;
}

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__dualTurretPatched) {
  prototype.__dualTurretPatched = true;
  const inheritedPreload = prototype.preload;
  const inheritedHandle = prototype.handleFreeEvent;
  const inheritedUpdate = prototype.updateWorld;
  const inheritedRemote = prototype.updateRemote;
  const inheritedStopAll = prototype.stopAll;

  prototype.preload = async function preloadWithDualTurret() {
    const inherited = inheritedPreload.call(this);
    await Promise.allSettled([inherited, preloadDualTurretAudio(this)]);
  };

  prototype.handleFreeEvent = function handleFreeEventWithDualTurret(event, playerIndex) {
    if (handleDualTurretAudioEvent(this, event, playerIndex)) return;
    return inheritedHandle.call(this, event, playerIndex);
  };

  // The common remote-audio layer assumes that every player occupies a
  // different ordinary boat. On the shared patrol boat it would create a
  // duplicate standard engine at distance zero. The dedicated spatial engine
  // below is the sole engine source for this boat.
  prototype.updateRemote = function updateRemoteWithoutDuplicateDualEngine(world, playerIndex) {
    const other = world?.players?.[1 - playerIndex];
    const otherBoat = other && ["boat", "roof"].includes(other.mode)
      ? world.boats?.[other.activeBoat]
      : null;
    if (isDualTurretBoat(otherBoat)) {
      this.stopRemoteLoop?.("remote");
      this.stopRemoteLoop?.("remoteWake");
      return;
    }
    return inheritedRemote.call(this, world, playerIndex);
  };

  prototype.updateWorld = function updateWorldWithDualTurret(world, playerIndex) {
    const boat = localDualBoat(world, playerIndex);
    const localIsDual = isDualTurretBoat(boat);

    // Preserve common wake, water, flooding and pump sounds, but prevent the
    // base engine from starting while the dedicated patrol-boat MP3 is active.
    const inheritedEnsureLoop = this.ensureLoop;
    if (localIsDual && typeof inheritedEnsureLoop === "function") {
      this.stopLoop?.("motorboatReal");
      this.ensureLoop = function ensureLoopWithoutStandardDualEngine(name, options) {
        if (name === "motorboatReal") return null;
        return inheritedEnsureLoop.call(this, name, options);
      };
    }

    let result;
    try {
      result = inheritedUpdate.call(this, world, playerIndex);
    } finally {
      if (localIsDual && typeof inheritedEnsureLoop === "function") this.ensureLoop = inheritedEnsureLoop;
    }

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
