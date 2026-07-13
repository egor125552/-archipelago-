"use strict";

import {AudioEngine as V8AudioEngine} from "./audio-engine-v8.js?base=4";

const RIVER_SOUNDS = Object.freeze({
  riverIdle: "/assets/audio/river-ambience.ogg",
  riverWake: "/assets/audio/boat-wake.ogg",
  bilgeWater: "/assets/audio/bilge-water.ogg",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function floodMuffleCutoff(waterPercent) {
  const flood = clamp((Number(waterPercent) || 0) / 100, 0, 1);
  const shaped = Math.pow(flood, 1.45);
  return 16_000 * Math.pow(560 / 16_000, shaped);
}

export class AudioEngine extends V8AudioEngine {
  constructor() {
    super();
    this.legacyLoopsCleared = false;
    this.floodFilter = null;
    this.nextFloodAlarmAt = 0;
    this.localPreloadPromise = null;
  }

  async init() {
    await super.init();
    // Base init starts preload without awaiting it. Wait only for the bundled
    // river recordings so the first launch cannot begin with silent water;
    // remote fallback libraries may continue downloading in the background.
    if (this.localPreloadPromise) await this.localPreloadPromise;
    if (!this.ctx || !this.compressor || this.floodFilter) return;
    this.floodFilter = this.ctx.createBiquadFilter();
    this.floodFilter.type = "lowpass";
    this.floodFilter.frequency.value = floodMuffleCutoff(0);
    this.floodFilter.Q.value = 0.58;
    try { this.compressor.disconnect(); } catch (_) {}
    this.compressor.connect(this.floodFilter).connect(this.ctx.destination);
  }

  async preload() {
    const inheritedPreload = super.preload();
    if (!this.ctx) return;
    this.localPreloadPromise = Promise.allSettled(Object.entries(RIVER_SOUNDS).map(async ([name, url]) => {
      const response = await fetch(url, {mode: "cors", cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
    await Promise.allSettled([inheritedPreload, this.localPreloadPromise]);
  }

  clearInheritedLoopsOnce() {
    if (this.legacyLoopsCleared) return;
    this.legacyLoopsCleared = true;
    for (const name of [
      "waterCalm", "waterWake", "rain", "engine", "pump", "seaV4", "hullV4", "wakeV4", "engineV4",
      "engineNew", "pumpNew", "seaPort", "seaStarboard", "bowWash", "seaReal", "motorboatReal", "pumpReal",
    ]) this.stopLoop(name);
  }

  updateFloodMuffle(water, playing) {
    if (!this.floodFilter || !this.ctx) return;
    const cutoff = floodMuffleCutoff(playing ? water : 0);
    this.floodFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.18);
  }

  updateFloodAlarm(view, playing) {
    if (!this.ctx) return;
    if (!playing || !view.damageControl?.floodEmergency) {
      this.nextFloodAlarmAt = 0;
      return;
    }
    if (this.ctx.currentTime < this.nextFloodAlarmAt) return;

    const remaining = Math.max(0, Number(view.damageControl.floodEmergencyRemaining) || 0);
    const urgent = remaining <= 10;
    this.playExcerpt("warningReal", {
      gain: urgent ? 0.54 : 0.45,
      rate: urgent ? 1.02 : 0.94,
      lowpass: 7600,
      offset: 0.1,
      duration: urgent ? 1.18 : 2.12,
    });
    // The synthesized pair remains audible if the recorded siren could not be
    // downloaded, and makes the repeating alarm distinct from sonar cues.
    this.playSynthPip({frequency: urgent ? 225 : 310, gain: urgent ? 0.14 : 0.1, duration: 0.18});
    this.playSynthPip({frequency: urgent ? 185 : 265, gain: urgent ? 0.13 : 0.09, duration: 0.2, delay: 0.28});
    this.nextFloodAlarmAt = this.ctx.currentTime + (urgent ? 1.28 : 2.34);
  }

  update(view) {
    if (!this.ctx) return;
    this.clearInheritedLoopsOnce();

    const riverReady = this.buffers.has("riverIdle") && this.buffers.has("riverWake") && this.buffers.has("bilgeWater");
    if (riverReady) this.stopLoop("seaReal");

    const speed = Math.abs(view.boat.speed);
    const load = Math.abs(view.boat.throttle);
    const water = clamp(Number(view.boat.water) || 0, 0, 100);
    const leak = clamp(Number(view.boat.leak) || 0, 0, 16);
    const playing = view.phase === "playing";
    const moving = speed >= 0.35;
    this.updateFloodMuffle(water, playing);
    this.updateFloodAlarm(view, playing);

    if (playing) {
      const idleName = this.buffers.has("riverIdle") ? "riverIdle" : "seaReal";
      this.ensureLoop(idleName, {
        gain: moving ? 0.022 : 0.038,
        rate: moving ? 0.96 : 0.91,
        lowpass: moving ? 3500 : 2550,
        pan: Math.sin(this.ctx.currentTime * 0.52) * 0.11,
      });

      if (moving) {
        const wakeName = this.buffers.has("riverWake") ? "riverWake" : "seaReal";
        const movement = clamp((speed - 0.25) / 10, 0, 1);
        this.ensureLoop(wakeName, {
          gain: 0.05 + movement * 0.25,
          rate: 0.84 + movement * 0.19,
          lowpass: 4300 + movement * 3600,
          pan: 0,
        });
      } else {
        this.stopLoop("riverWake");
      }

      if (!view.boat.engineStalled) {
        this.ensureLoop("motorboatReal", {
          gain: 0.06 + load * 0.22,
          rate: 0.9 + load * 0.17,
          lowpass: 1500 + load * 2100,
          pan: 0,
        });
      } else this.stopLoop("motorboatReal");

      if (water > 0.7 || leak > 0.05) {
        const flooding = clamp(water / 100, 0, 1);
        const bilgeName = this.buffers.has("bilgeWater") ? "bilgeWater" : "seaReal";
        this.ensureLoop(bilgeName, {
          gain: 0.018 + flooding * 0.22 + Math.min(0.045, leak / 260),
          rate: 0.82 + flooding * 0.1,
          lowpass: 2600 - flooding * 1200,
          pan: -0.12 + Math.sin(this.ctx.currentTime * 0.37) * 0.08,
        });
      } else {
        this.stopLoop("bilgeWater");
      }

      if (view.boat.pumpActive) {
        this.ensureLoop("pumpReal", {gain: 0.18, rate: 0.93, lowpass: 3300, pan: -0.16});
      } else this.stopLoop("pumpReal");
    } else {
      for (const name of ["riverIdle", "riverWake", "bilgeWater", "seaReal", "motorboatReal", "pumpReal"]) this.stopLoop(name);
    }

    if (playing) {
      this.playGuide(view);
      this.playHazardGuide(view);
    }
  }

  handle(events) {
    for (const event of events || []) {
      if (event.type === "motion-start") {
        this.playExcerpt(this.buffers.has("riverWake") ? "riverWake" : "seaReal", {
          gain: 0.14,
          rate: 0.9,
          lowpass: 6000,
          offset: 0.1,
          duration: 0.72,
        });
      } else if (event.type === "motion-stop") {
        this.playExcerpt(this.buffers.has("riverIdle") ? "riverIdle" : "seaReal", {
          gain: 0.105,
          rate: 0.9,
          lowpass: 3000,
          offset: 0.05,
          duration: 0.65,
        });
      } else if (event.type === "flood-emergency-start") {
        this.playExcerpt("warningReal", {gain: 0.46, rate: 0.94, lowpass: 7200, offset: 0.1, duration: 2.08});
        this.playSynthPip({frequency: 360, gain: 0.1, duration: 0.16, delay: 0.2});
        if (this.ctx) this.nextFloodAlarmAt = this.ctx.currentTime + 2.2;
      } else if (event.type === "flood-emergency-warning") {
        this.playSynthPip({frequency: event.critical ? 230 : 310, gain: event.critical ? 0.13 : 0.09, duration: 0.18});
      } else if (event.type === "flood-emergency-recovered") {
        this.playSynthPip({frequency: 540, gain: 0.075, duration: 0.1});
        this.playSynthPip({frequency: 720, gain: 0.08, duration: 0.1, delay: 0.16});
      } else if (event.type === "flood-emergency-failed") {
        this.playExcerpt("warningReal", {gain: 0.52, rate: 0.9, lowpass: 7600, offset: 0.1, duration: 1.85});
      } else if (event.type === "safety-brake") {
        this.playSynthPip({pan: event.pan || 0, frequency: 300, gain: 0.075, duration: 0.11});
      } else if (event.type === "safety-toggle") {
        this.playSynthPip({frequency: event.enabled ? 610 : 410, gain: 0.065, duration: 0.08});
      } else if (event.type === "route-advance") {
        this.playSynthPip({pan: event.pan || 0, frequency: 620, gain: 0.075, duration: 0.09});
        this.playSynthPip({pan: event.pan || 0, frequency: 790, gain: 0.08, duration: 0.08, delay: 0.14});
      } else if (event.type === "docking-assist") {
        this.playSynthPip({frequency: 470, gain: 0.075, duration: 0.1});
        this.playSynthPip({frequency: 590, gain: 0.07, duration: 0.09, delay: 0.16});
      } else if (event.type === "course-hold") {
        this.playSynthPip({frequency: 840, gain: 0.075, duration: 0.08});
        this.playSynthPip({frequency: 980, gain: 0.08, duration: 0.07, delay: 0.13});
      } else if (event.type === "approach-assist") {
        this.playSynthPip({frequency: 560, gain: 0.07, duration: 0.09});
        this.playSynthPip({frequency: 690, gain: 0.07, duration: 0.08, delay: 0.14});
      } else if (event.type === "risk-route-toggle") {
        this.playSynthPip({frequency: event.enabled ? 920 : 520, gain: 0.075, duration: 0.08});
        this.playSynthPip({frequency: event.enabled ? 690 : 440, gain: 0.07, duration: 0.1, delay: 0.14});
      } else if (event.type === "risk-gate-cleared") {
        this.playSynthPip({frequency: 760, gain: 0.08, duration: 0.08});
        this.playSynthPip({frequency: 980, gain: 0.085, duration: 0.09, delay: 0.13});
        this.playSynthPip({frequency: 1220, gain: 0.08, duration: 0.1, delay: 0.27});
      } else if (event.type === "risk-gate-entered") {
        this.playSynthPip({pan: event.pan || 0, frequency: 700, gain: 0.07, duration: 0.08});
        this.playSynthPip({pan: event.pan || 0, frequency: 820, gain: 0.075, duration: 0.08, delay: 0.13});
      } else if (event.type === "risk-gate-failed") {
        this.playSynthPip({frequency: 360, gain: 0.085, duration: 0.12});
        this.playSynthPip({frequency: 280, gain: 0.075, duration: 0.14, delay: 0.17});
      } else {
        super.handle([event]);
      }
    }
  }
}
