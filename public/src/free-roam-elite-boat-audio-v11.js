"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=44";

if (!FreeRoamAudio.prototype.__eliteBoatAudioV12) {
  const inheritedHandleFreeEvent = FreeRoamAudio.prototype.handleFreeEvent;

  Object.defineProperty(FreeRoamAudio.prototype, "__eliteBoatAudioV12", {value: true});

  FreeRoamAudio.prototype.handleFreeEvent = function handleEliteBoatAudio(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const spatial = this.eventPanAndGain(event, 240);

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
      case "elite-bomb-bay-armoured-hit":
        this.playSynthPip({pan: spatial.pan, frequency: 110, gain: 0.16 * spatial.gain, duration: 0.08});
        this.playSynthPip({pan: spatial.pan, frequency: 70, gain: 0.12 * spatial.gain, duration: 0.12, delay: 0.05});
        return;
      case "elite-bomb-bay-hit":
        this.play("gunHit", {pan: spatial.pan, gain: 0.82 * spatial.gain, rate: 0.86, lowpass: 6200});
        return;
      case "elite-bomb-bay-destroyed":
        this.playSynthPip({pan: spatial.pan, frequency: 410, gain: 0.2 * spatial.gain, duration: 0.08});
        this.playSynthPip({pan: spatial.pan, frequency: 92, gain: 0.23 * spatial.gain, duration: 0.34, delay: 0.09});
        return;
      case "elite-bomb-bay-internal-detonation":
        this.playSynthPip({pan: spatial.pan, frequency: 62, gain: 0.28 * spatial.gain, duration: 0.48});
        this.playSynthPip({pan: spatial.pan, frequency: 38, gain: 0.24 * spatial.gain, duration: 0.58, delay: 0.08});
        return;
      case "elite-bullet-flyby":
        this.playSynthPip({pan: spatial.pan, frequency: 1850, gain: 0.12 * spatial.gain, duration: 0.045});
        this.playSynthPip({pan: -spatial.pan * 0.35, frequency: 1320, gain: 0.07 * spatial.gain, duration: 0.055, delay: 0.025});
        return;
      case "elite-bullet-ended":
        if (["terrain-impact", "boundary-impact"].includes(event.reason)) {
          this.play("gunHit", {pan: spatial.pan, gain: 0.35 * spatial.gain, rate: 1.18, lowpass: 5200});
        }
        return;
      case "elite-boat-boundary-impact":
        this.playSynthPip({pan: spatial.pan, frequency: 58, gain: 0.25 * spatial.gain, duration: 0.3});
        this.playSynthPip({pan: spatial.pan, frequency: 92, gain: 0.16 * spatial.gain, duration: 0.16, delay: 0.04});
        return;
      case "elite-ram-impact":
        this.playSynthPip({pan: spatial.pan, frequency: 48, gain: 0.3 * spatial.gain, duration: 0.38});
        this.playSynthPip({pan: spatial.pan, frequency: 76, gain: 0.2 * spatial.gain, duration: 0.24, delay: 0.04});
        return;
      default:
        return inheritedHandleFreeEvent.call(this, event, playerIndex);
    }
  };
}
