"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=44";

if (!FreeRoamAudio.prototype.__eliteBoatAudioV11) {
  const inheritedHandleFreeEvent = FreeRoamAudio.prototype.handleFreeEvent;

  Object.defineProperty(FreeRoamAudio.prototype, "__eliteBoatAudioV11", {value: true});

  FreeRoamAudio.prototype.handleFreeEvent = function handleEliteBoatAudio(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const spatial = this.eventPanAndGain(event, 220);

    switch (event.type) {
      case "elite-bomb-bay-opening":
        this.playSynthPip({pan: spatial.pan, frequency: 82, gain: 0.13 * spatial.gain, duration: 0.18});
        this.playSynthPip({pan: spatial.pan, frequency: 112, gain: 0.15 * spatial.gain, duration: 0.16, delay: 0.16});
        this.playSynthPip({pan: spatial.pan, frequency: 148, gain: 0.17 * spatial.gain, duration: 0.14, delay: 0.32});
        return;
      case "elite-bomb-bay-closing":
        this.playSynthPip({pan: spatial.pan, frequency: 145, gain: 0.14 * spatial.gain, duration: 0.14});
        this.playSynthPip({pan: spatial.pan, frequency: 104, gain: 0.15 * spatial.gain, duration: 0.17, delay: 0.14});
        this.playSynthPip({pan: spatial.pan, frequency: 76, gain: 0.16 * spatial.gain, duration: 0.19, delay: 0.29});
        return;
      case "elite-bomb-bay-closed":
        this.playSynthPip({pan: spatial.pan, frequency: 64, gain: 0.19 * spatial.gain, duration: 0.09});
        this.playSynthPip({pan: spatial.pan, frequency: 48, gain: 0.13 * spatial.gain, duration: 0.12, delay: 0.07});
        return;
      default:
        return inheritedHandleFreeEvent.call(this, event, playerIndex);
    }
  };
}
