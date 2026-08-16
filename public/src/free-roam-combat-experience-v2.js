"use strict";

import "./free-roam-combat-experience-v1.js?v=2";
import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=43";
import {installSpeechReliability} from "./free-roam-speech-reliability-v1.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MOVING_PHASES = new Set([
  "breach-escaping-v166",
  "breach-stopping-v166",
  "breach-returning-v166",
]);
const REPAIR_PHASE = "breach-repairing-v166";
const CUSTOM_EVENTS = new Set([
  "heavy-breach-escape-v166",
  "heavy-breach-turn-v166",
  "heavy-system-recovery-v166",
  "heavy-repair-start-v166",
  "heavy-repair-progress-v166",
  "heavy-repair-complete-v166",
  "heavy-repair-no-plates",
  "heavy-breach-returned-v166",
]);

installSpeechReliability();

function ensureHeavyLoop(audio) {
  if (audio.combatExperienceHeavyLoop || !audio.ctx || !audio.master || !audio.buffers.has("motorboatReal")) return;
  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get("motorboatReal");
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = 500;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  audio.combatExperienceHeavyLoop = {source, filter, panner, gain};
}

const previousHandle = FreeRoamAudio.prototype.handleFreeEvent;
FreeRoamAudio.prototype.handleFreeEvent = function handleCombatExperienceV2(event, playerIndex) {
  if (!CUSTOM_EVENTS.has(event?.type)) return previousHandle.call(this, event, playerIndex);
  if (!event?.targets?.includes(playerIndex)) return;
  const sound = this.eventPanAndGain(event, 360);
  if (sound.gain <= 0.002) return;
  const repairing = event.type.includes("repair");
  const noPlates = event.type === "heavy-repair-no-plates";
  const frequencies = noPlates ? [110, 82] : repairing ? [300, 185] : [118, 210];
  this.playSynthPip({pan: sound.pan, frequency: frequencies[0], gain: 0.17 * sound.gain, duration: 0.18});
  this.playSynthPip({pan: sound.pan, frequency: frequencies[1], gain: 0.14 * sound.gain, duration: 0.21, delay: 0.2});
};

const previousUpdateWorld = FreeRoamAudio.prototype.updateWorld;
FreeRoamAudio.prototype.updateWorld = function updateCombatExperienceV2(world, playerIndex) {
  previousUpdateWorld.call(this, world, playerIndex);
  const boat = world?.freeHeavyPursuer?.boat;
  const phase = world?.freeCombatAiV164?.heavy?.phase;
  if (MOVING_PHASES.has(phase) && this.ctx && this.listenerPoint && boat?.active && !boat.destroyed) {
    ensureHeavyLoop(this);
    const sound = this.eventPanAndGain(boat, 360);
    const speed = clamp(Math.abs(Number(boat.speed) || 0) / 13.4, 0, 1);
    const now = this.ctx.currentTime;
    if (this.combatExperienceHeavyLoop) {
      this.combatExperienceHeavyLoop.source.playbackRate.setTargetAtTime(0.55 + speed * 0.25, now, 0.1);
      this.combatExperienceHeavyLoop.filter.frequency.setTargetAtTime(430 + sound.gain * 2500, now, 0.14);
      this.combatExperienceHeavyLoop.panner.pan.setTargetAtTime(sound.pan, now, 0.08);
      this.combatExperienceHeavyLoop.gain.gain.setTargetAtTime((0.018 + speed * 0.2) * sound.gain, now, 0.13);
    }
  }

  if (phase === REPAIR_PHASE && boat?.active && !boat.destroyed && this.ctx) {
    this.combatExperienceRepairV2At ||= 0;
    if (this.ctx.currentTime >= this.combatExperienceRepairV2At) {
      this.combatExperienceRepairV2At = this.ctx.currentTime + 0.82;
      const sound = this.eventPanAndGain(boat, 280);
      if (sound.gain > 0.002) {
        if (this.buffers.has("repair")) {
          this.play("repair", {pan: sound.pan, gain: 0.4 * sound.gain, rate: 0.8, lowpass: 1200 + sound.gain * 4400});
        } else {
          this.playSynthPip({pan: sound.pan, frequency: 315, gain: 0.1 * sound.gain, duration: 0.09});
          this.playSynthPip({pan: sound.pan, frequency: 185, gain: 0.08 * sound.gain, duration: 0.13, delay: 0.13});
        }
      }
    }
  }
};
