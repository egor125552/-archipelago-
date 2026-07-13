"use strict";

import {AudioEngine as V6AudioEngine} from "./audio-engine-v6.js?base=4";

export class AudioEngine extends V6AudioEngine {
  constructor() {
    super();
    this.nextGuidePipAt = 0;
    this.nextHazardPipAt = 0;
  }

  playSynthPip({pan = 0, frequency = 760, gain = 0.08, duration = 0.085, delay = 0} = {}) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const at = this.ctx.currentTime + delay;
    const oscillator = this.ctx.createOscillator();
    const envelope = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, at);
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), at);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(panner).connect(envelope).connect(this.master);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }

  playGuide(view) {
    const navigation = view.navigation;
    if (!navigation?.assistEnabled || !navigation.lockedTargetId || navigation.guideDistance == null) return;
    if (this.ctx.currentTime < this.nextGuidePipAt) return;
    const near = navigation.guideDistance < 18;
    const centered = Boolean(navigation.guideCentered);
    const pan = centered ? 0 : navigation.guidePan || 0;
    this.playSynthPip({pan, frequency: centered ? 920 : near ? 820 : 720, gain: centered ? 0.095 : 0.075, duration: 0.075});
    if (centered) this.playSynthPip({pan: 0, frequency: 990, gain: 0.08, duration: 0.065, delay: 0.13});
    this.nextGuidePipAt = this.ctx.currentTime + (near ? 0.52 : 0.78);
  }

  playHazardGuide(view) {
    const navigation = view.navigation;
    const metres = navigation?.nearestHazardDistance;
    const angle = navigation?.nearestHazardRelativeAngle;
    if (metres == null || metres > 29 || Math.abs(angle || 0) > 70) return;
    if (this.ctx.currentTime < this.nextHazardPipAt) return;
    this.playSynthPip({
      pan: navigation.nearestHazardPan || 0,
      frequency: metres < 14 ? 210 : 270,
      gain: metres < 14 ? 0.105 : 0.065,
      duration: metres < 14 ? 0.13 : 0.09,
    });
    this.nextHazardPipAt = this.ctx.currentTime + Math.max(0.42, Math.min(1.05, metres / 30));
  }

  update(view) {
    super.update(view);
    if (!this.ctx || view.phase !== "playing") return;
    this.playGuide(view);
    this.playHazardGuide(view);
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "zone-enter") {
        this.playSynthPip({frequency: 520, gain: 0.06, duration: 0.09});
        this.playSynthPip({frequency: 660, gain: 0.055, duration: 0.08, delay: 0.13});
      } else if (event.type === "hazard-warning") {
        this.playSynthPip({pan: event.pan || 0, frequency: 240, gain: 0.11, duration: 0.16});
      } else {
        super.handle([event]);
      }
    }
  }
}
