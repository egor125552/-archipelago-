"use strict";

import {AudioEngine as V7AudioEngine} from "./audio-engine-v7-1.js?base=4";

export class AudioEngine extends V7AudioEngine {
  constructor() {
    super();
    this.nextGuidePipAt = 0;
    this.nextHazardPipAt = 0;
  }

  playGuide(view) {
    const navigation = view.navigation;
    if (!navigation?.assistEnabled || navigation.beaconSuppressed || navigation.rescueMode || !navigation.lockedTargetId || navigation.guideDistance == null) return;
    if (this.ctx.currentTime < this.nextGuidePipAt) return;

    const metres = navigation.guideDistance;
    const centered = Boolean(navigation.beaconCentered ?? navigation.guideCentered);
    const pan = centered ? 0 : (navigation.beaconPan ?? navigation.guidePan ?? 0);
    const near = metres < 18;
    const frequency = centered ? 930 : near ? 810 : 690;

    this.playSynthPip({pan, frequency, gain: centered ? 0.09 : 0.07, duration: 0.075});
    if (centered) {
      this.playSynthPip({pan: 0, frequency: 1010, gain: 0.072, duration: 0.06, delay: 0.14});
    }

    this.nextGuidePipAt = this.ctx.currentTime + (centered ? 0.92 : near ? 0.68 : 0.9);
  }

  playHazardGuide(view) {
    const navigation = view.navigation;
    if (navigation?.rescueMode) return;
    const metres = navigation?.nearestHazardDistance;
    const angle = navigation?.nearestHazardRelativeAngle;
    if (metres == null || metres > 27 || Math.abs(angle || 0) > 30) return;
    if (this.ctx.currentTime < this.nextHazardPipAt) return;

    this.playSynthPip({
      pan: navigation.nearestHazardPan || 0,
      frequency: metres < 13 ? 190 : 245,
      gain: metres < 13 ? 0.095 : 0.055,
      duration: metres < 13 ? 0.14 : 0.09,
    });
    this.nextHazardPipAt = this.ctx.currentTime + (metres < 13 ? 0.62 : 1.05);
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "capture-ready") {
        this.playSynthPip({pan: event.pan || 0, frequency: 1080, gain: 0.09, duration: 0.08});
        this.playSynthPip({pan: event.pan || 0, frequency: 1180, gain: 0.075, duration: 0.07, delay: 0.16});
      } else if (event.type === "location-report" || event.type === "tutorial") {
        // Spoken on demand; no extra alert is needed.
      } else {
        super.handle([event]);
      }
    }
  }
}
