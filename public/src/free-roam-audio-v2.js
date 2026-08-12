"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio.js?v=39";
import {handleDualTurretAudioEvent} from "./free-roam-dual-turret-audio.js?v=7";

const ORDINARY_LOCAL_ENGINE_LOOPS = Object.freeze([
  "motorboatReal",
  "engine",
  "engineNew",
  "engineV4",
]);

function isOrdinaryLocalEngine(name) {
  return ORDINARY_LOCAL_ENGINE_LOOPS.includes(name);
}

function hasDedicatedVesselEngine(boat) {
  const profile = String(boat?.audioProfile || "");
  return profile.startsWith("dual-turret") || profile.startsWith("medium-crew");
}

export class FreeRoamAudio extends BaseFreeRoamAudio {
  constructor() {
    super();
    this.ordinaryLocalEngineAllowed = false;
  }

  stopOrdinaryLocalEngine() {
    for (const name of ORDINARY_LOCAL_ENGINE_LOOPS) this.stopLoop?.(name);
  }

  ensureLoop(name, options) {
    if (isOrdinaryLocalEngine(name) && !this.ordinaryLocalEngineAllowed) {
      this.stopLoop?.(name);
      return null;
    }
    return super.ensureLoop(name, options);
  }

  updateWorld(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    const localBoat = player && ["boat", "roof"].includes(player.mode)
      ? world?.boats?.[player.activeBoat]
      : null;
    this.ordinaryLocalEngineAllowed = Boolean(
      localBoat
      && !localBoat.sunk
      && !hasDedicatedVesselEngine(localBoat),
    );

    if (!this.ordinaryLocalEngineAllowed) this.stopOrdinaryLocalEngine();
    super.updateWorld(world, playerIndex);
    if (!this.ordinaryLocalEngineAllowed) this.stopOrdinaryLocalEngine();
  }

  handleFreeEvent(event, playerIndex) {
    if (handleDualTurretAudioEvent(this, event, playerIndex)) return;
    if (event?.operationEvent && event?.targets?.includes(playerIndex)) {
      this.handle([event]);
      return;
    }
    super.handleFreeEvent(event, playerIndex);
  }
}
