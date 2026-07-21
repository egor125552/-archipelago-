"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio-v5.js?v=39";

const ROOT = "/assets/audio/free-roam-v25/";
const CORE_SOUNDS = Object.freeze({
  riverIdle: "/assets/audio/river-ambience.ogg",
  riverWake: "/assets/audio/boat-wake.ogg",
  bilgeWater: "/assets/audio/bilge-water.ogg",
  swimImpactV25: ROOT + "swim-impact.mp3",
  gunHit: ROOT + "gun-hit.mp3",
  automaticShot: ROOT + "automatic-shot.mp3",
  stepV25_1: ROOT + "step-1.mp3",
  stepV25_2: ROOT + "step-2.mp3",
  stepV25_3: ROOT + "step-3.mp3",
  stepV25_4: ROOT + "step-4.mp3",
});

const DEFERRED_SOUNDS = Object.freeze({
  heartbeatFast: ROOT + "heartbeat-fast.mp3",
  deathFull: ROOT + "death-full.mp3",
  swingLight: ROOT + "swing-light.mp3",
  swingHeavy: ROOT + "swing-heavy.mp3",
  punch1: ROOT + "punch-1.mp3",
  punch2: ROOT + "punch-2.mp3",
  punch3: ROOT + "punch-3.mp3",
  punchHeavy: ROOT + "punch-heavy.mp3",
  punchBodySet: ROOT + "punch-body-set.mp3",
  hitPlayer: ROOT + "hit-player.mp3",
  knifeDraw: ROOT + "knife-draw.mp3",
  knife1: ROOT + "knife-1.mp3",
  knife2: ROOT + "knife-2.mp3",
  knife3: ROOT + "knife-3.mp3",
  lakeWaterV25: ROOT + "lake-water.mp3",
});

const RAPID_SOUND_LIMITS = Object.freeze({
  automaticShot: Object.freeze({minimumGap: 0.032, maximumVoices: 6}),
  gunHit: Object.freeze({minimumGap: 0.024, maximumVoices: 5}),
  swingLight: Object.freeze({minimumGap: 0.028, maximumVoices: 4}),
});

function copyAlias(buffers, target, source) {
  const buffer = buffers.get(source);
  if (buffer) buffers.set(target, buffer);
}

export class FreeRoamAudio extends BaseFreeRoamAudio {
  constructor() {
    super();
    this.bundledCorePromise = null;
    this.deferredStarted = false;
    this.rapidSoundAt = new Map();
    this.rapidSoundVoices = new Map();
    if (this.spatialDiagnostics) this.spatialDiagnostics.rapidSoundsDropped = 0;
  }

  play(name, options = {}) {
    const limit = options.loop ? null : RAPID_SOUND_LIMITS[name];
    if (!limit || !this.ctx) return super.play(name, options);
    const now = this.ctx.currentTime;
    const voices = this.rapidSoundVoices.get(name) || new Set();
    const lastAt = this.rapidSoundAt.get(name) ?? -Infinity;
    if (now - lastAt < limit.minimumGap || voices.size >= limit.maximumVoices) {
      if (this.spatialDiagnostics) this.spatialDiagnostics.rapidSoundsDropped += 1;
      return null;
    }
    const source = super.play(name, options);
    if (!source) return null;
    this.rapidSoundAt.set(name, now);
    voices.add(source);
    this.rapidSoundVoices.set(name, voices);
    const inheritedEnded = source.onended;
    source.onended = event => {
      voices.delete(source);
      inheritedEnded?.call(source, event);
    };
    return source;
  }

  createTone(name, frequency, duration = 0.16) {
    if (!this.ctx || this.buffers.has(name)) return;
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      const time = index / this.ctx.sampleRate;
      const fade = Math.pow(1 - index / length, 2.2);
      data[index] = Math.sin(Math.PI * 2 * frequency * time) * fade * 0.34;
    }
    this.buffers.set(name, buffer);
  }

  createMachineLoop(name, fundamental, wobble) {
    if (!this.ctx || this.buffers.has(name)) return;
    const duration = 1.5;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      const time = index / this.ctx.sampleRate;
      const modulation = 1 + Math.sin(Math.PI * 2 * wobble * time) * 0.08;
      data[index] = (
        Math.sin(Math.PI * 2 * fundamental * time) * 0.28
        + Math.sin(Math.PI * 2 * fundamental * 2 * time) * 0.12
        + Math.sin(Math.PI * 2 * fundamental * 3 * time) * 0.05
      ) * modulation;
    }
    this.buffers.set(name, buffer);
  }

  async loadSounds(manifest) {
    if (!this.ctx) return;
    await Promise.allSettled(Object.entries(manifest).map(async ([name, url]) => {
      if (this.buffers.has(name)) return;
      const response = await fetch(url, {cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      this.buffers.set(name, await this.ctx.decodeAudioData(await response.arrayBuffer()));
    }));
  }

  installCoreAliases() {
    for (const name of ["seaReal", "waterCalm"]) copyAlias(this.buffers, name, "riverIdle");
    for (const name of ["waterWake", "wakeV4"]) copyAlias(this.buffers, name, "riverWake");
    for (const name of ["waterSoft", "waterSide", "waterBow", "waterHeavy", "splash"]) {
      copyAlias(this.buffers, name, "swimImpactV25");
    }
    for (const name of ["collision", "collisionNew", "hullImpactReal", "hullCreak", "repair", "hullRepair", "rope", "ropeNew"]) {
      copyAlias(this.buffers, name, "gunHit");
    }
    for (let index = 1; index <= 3; index += 1) copyAlias(this.buffers, `footstepFree${index}`, `stepV25_${index}`);
  }

  startDeferredPreload() {
    if (this.deferredStarted) return;
    this.deferredStarted = true;
    const load = () => {
      this.combatPreloadPromise = this.loadSounds(DEFERRED_SOUNDS).then(() => {
        copyAlias(this.buffers, "warningReal", "heartbeatFast");
      });
    };
    if (typeof globalThis.requestIdleCallback === "function") {
      globalThis.requestIdleCallback(load, {timeout: 2_500});
    } else {
      setTimeout(load, 800);
    }
  }

  async preload() {
    if (!this.ctx) return;
    if (this.bundledCorePromise) return this.bundledCorePromise;

    // Free roam previously walked through every historical audio manifest,
    // fetching dozens of cross-origin files that later layers immediately
    // stopped. Load only the current bundled mix and defer combat recordings.
    this.createMachineLoop("motorboatReal", 48, 4);
    this.createMachineLoop("pumpReal", 36, 6);
    this.createTone("sonar", 620);
    this.createTone("sonarNear", 880);
    this.createTone("deny", 190, 0.12);
    this.createTone("warning", 240, 0.32);
    this.createTone("rescue", 720, 0.22);
    this.createTone("win", 940, 0.32);

    this.bundledCorePromise = this.loadSounds(CORE_SOUNDS).then(() => {
      this.installCoreAliases();
      this.startDeferredPreload();
    });
    return this.bundledCorePromise;
  }
}
