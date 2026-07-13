"use strict";

import {AudioEngine as V7AudioEngine} from "./audio-engine-v7.js?base=4";

export class AudioEngine extends V7AudioEngine {
  playHazardGuide(view) {
    const navigation = view.navigation;
    const metres = navigation?.nearestHazardDistance;
    const angle = navigation?.nearestHazardRelativeAngle;
    if (metres == null || metres > 29 || Math.abs(angle || 0) > 30) return;
    if (this.ctx.currentTime < this.nextHazardPipAt) return;
    this.playSynthPip({
      pan: navigation.nearestHazardPan || 0,
      frequency: metres < 14 ? 210 : 270,
      gain: metres < 14 ? 0.105 : 0.065,
      duration: metres < 14 ? 0.13 : 0.09,
    });
    this.nextHazardPipAt = this.ctx.currentTime + Math.max(0.42, Math.min(1.05, metres / 30));
  }
}
