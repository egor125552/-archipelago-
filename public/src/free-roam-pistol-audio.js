"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=38";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=33";

const PISTOL_URL = "/assets/audio/free-roam-v25/pistol-shot.mp3.base64";
const originalPreload = FreeRoamAudio.prototype.preload;
const originalImpact = FreeRoamAudio.prototype.playCombatImpact;
const originalHandle = FreeRoamAudio.prototype.handleFreeEvent;

function base64AudioBuffer(text) {
  const clean = String(text || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

FreeRoamAudio.prototype.preload = async function preloadWithPistol() {
  const inherited = originalPreload.call(this);
  if (!this.ctx) return inherited;
  if (!this.pistolPreloadPromise) {
    this.pistolPreloadPromise = (async () => {
      const response = await fetch(PISTOL_URL, {cache: "force-cache"});
      if (!response.ok) throw new Error(`pistolShot: ${response.status}`);
      const encoded = await response.text();
      this.buffers.set("pistolShot", await this.ctx.decodeAudioData(base64AudioBuffer(encoded)));
    })();
  }
  await Promise.allSettled([inherited, this.pistolPreloadPromise]);
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
    if (this.buffers.has("pistolShot")) {
      this.play("pistolShot", {
        pan: spatial.pan,
        gain: COMBAT_TUNING.pistolShotGain * spatial.gain,
        rate: 0.985 + Math.random() * 0.03,
        lowpass: 13500,
      });
    } else {
      this.playSynthPip({pan: spatial.pan, frequency: 980, gain: 0.16 * spatial.gain, duration: 0.07});
    }
    return;
  }
  if (event?.type === "weapon-switch" && event.weapon === "pistol") {
    if (!event.targets?.includes(playerIndex)) return;
    this.playSynthPip({frequency: 620, gain: 0.085, duration: 0.08});
    return;
  }
  return originalHandle.call(this, event, playerIndex);
};
