"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio.js?v=39";
import {handleDualTurretAudioEvent} from "./free-roam-dual-turret-audio.js?v=5";

export class FreeRoamAudio extends BaseFreeRoamAudio {
  handleFreeEvent(event, playerIndex) {
    if (handleDualTurretAudioEvent(this, event, playerIndex)) return;
    if (event?.operationEvent && event?.targets?.includes(playerIndex)) {
      this.handle([event]);
      return;
    }
    super.handleFreeEvent(event, playerIndex);
  }
}
