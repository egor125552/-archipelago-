"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=38";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=33";

const PISTOL_RECORDING_URL = "https://raw.githubusercontent.com/Gabrielsgp/hand-shotter/a9e2dac862291cbff1af8e2c3e82922c3aeb726c/songs/163456__lemudcrab__pistol-shot.wav";
const originalPreload = FreeRoamAudio.prototype.preload;
const originalImpact = FreeRoamAudio.prototype.playCombatImpact;
const originalHandle = FreeRoamAudio.prototype.handleFreeEvent;

function createFallbackPistolBuffer(ctx) {
  const sampleRate = ctx.sampleRate;
  const duration = 0.58;
  const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x5031570;
  let previousNoise = 0;

  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };

  for (let index = 0; index < data.length; index += 1) {
    const time = index / sampleRate;
    const white = random();
    previousNoise = previousNoise * 0.72 + white * 0.28;
    const crack = time < 0.012 ? white * Math.exp(-time * 260) : 0;
    const body = (
      Math.sin(2 * Math.PI * 155 * time) * 0.5
      + Math.sin(2 * Math.PI * 310 * time + 0.35) * 0.22
      + previousNoise * 0.72
    ) * Math.exp(-time * 25);
    const snap = Math.sin(2 * Math.PI * 2350 * time) * Math.exp(-time * 95) * 0.16;
    const firstReflection = time > 0.052
      ? Math.sin(2 * Math.PI * 205 * (time - 0.052)) * Math.exp(-(time - 0.052) * 36) * 0.15
      : 0;
    const secondReflection = time > 0.105
      ? previousNoise * Math.exp(-(time - 0.105) * 31) * 0.08
      : 0;
    data[index] = Math.tanh((crack * 1.25 + body + snap + firstReflection + secondReflection) * 1.45) * 0.82;
  }
  return buffer;
}

async function loadRecordedPistol(ctx) {
  const response = await fetch(PISTOL_RECORDING_URL, {cache: "force-cache", mode: "cors"});
  if (!response.ok) throw new Error(`pistolShot: ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 1_000) throw new Error("pistolShot: recording is empty");
  return ctx.decodeAudioData(bytes.slice(0));
}

FreeRoamAudio.prototype.preload = async function preloadWithPistol() {
  const inherited = originalPreload.call(this);
  if (this.ctx && !this.pistolPreloadPromise) {
    this.pistolPreloadPromise = loadRecordedPistol(this.ctx)
      .catch(() => createFallbackPistolBuffer(this.ctx))
      .then(buffer => this.buffers.set("pistolShot", buffer));
  }
  await Promise.allSettled([inherited, this.pistolPreloadPromise]);
  if (this.ctx && !this.buffers.has("pistolShot")) {
    this.buffers.set("pistolShot", createFallbackPistolBuffer(this.ctx));
  }
};

FreeRoamAudio.prototype.playCombatImpact = function playCombatImpactWithPistol(event, playerIndex) {
  if (event?.weapon !== "pistol") return originalImpact.call(this, event, playerIndex);
  const spatial = this.eventPanAndGain(event, COMBAT_TUNING.pistolImpactRange);
  const localTarget = event.targetPlayer === playerIndex;
  const gain = (localTarget ? 0.72 : 0.5) * spatial.gain * COMBAT_TUNING.pistolImpactGain;
  this.play("gunHit", {pan: spatial.pan, gain, lowpass: 9800});
  if (localTarget) this.play("hitPlayer", {gain: 0.34, pan: 0, lowpass: 7000});
};

FreeRoamAudio.prototype.handleFreeEvent = function handleFreeEventWithPistol(event, playerIndex) {
  if (event?.type === "gun-shot" && event.weapon === "pistol") {
    if (!event.targets?.includes(playerIndex)) return;
    const spatial = this.eventPanAndGain(event, COMBAT_TUNING.pistolAudibleRange);
    this.play("pistolShot", {
      pan: spatial.pan,
      gain: COMBAT_TUNING.pistolShotGain * spatial.gain,
      rate: 0.985 + Math.random() * 0.03,
      lowpass: 13500,
    });
    return;
  }
  if (event?.type === "weapon-switch" && event.weapon === "pistol") {
    if (!event.targets?.includes(playerIndex)) return;
    this.playSynthPip({frequency: 620, gain: 0.085, duration: 0.08});
    return;
  }
  return originalHandle.call(this, event, playerIndex);
};
