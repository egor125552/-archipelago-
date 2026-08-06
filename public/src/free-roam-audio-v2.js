"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio.js?v=39";
import {handleDualTurretAudioEvent} from "./free-roam-dual-turret-audio.js?v=7";

const ORDINARY_LOCAL_ENGINE_LOOPS = Object.freeze([
  "motorboatReal",
  "engine",
  "engineNew",
  "engineV4",
]);

export class FreeRoamAudio extends BaseFreeRoamAudio {
  stopOrdinaryLocalEngine() {
    for (const name of ORDINARY_LOCAL_ENGINE_LOOPS) this.stopLoop?.(name);
  }

  updateWorld(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    const localBoat = player && ["boat", "roof"].includes(player.mode)
      ? world?.boats?.[player.activeBoat]
      : null;
    const ordinaryBoatAboard = Boolean(localBoat && localBoat.audioProfile !== "dual-turret");
    if (!ordinaryBoatAboard) this.stopOrdinaryLocalEngine();
    super.updateWorld(world, playerIndex);
    if (!ordinaryBoatAboard) this.stopOrdinaryLocalEngine();
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
