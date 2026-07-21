"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio.js?v=38";

export class FreeRoamAudio extends BaseFreeRoamAudio {
  handleFreeEvent(event, playerIndex) {
    if (event?.operationEvent && event?.targets?.includes(playerIndex)) {
      this.handle([event]);
      return;
    }
    super.handleFreeEvent(event, playerIndex);
  }
}
