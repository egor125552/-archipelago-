"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=44";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);

if (!FreeRoamAudio.prototype.__eliteBoatAudioV12) {
  const inheritedHandleFreeEvent = FreeRoamAudio.prototype.handleFreeEvent;
  const inheritedUpdateMarauderEngine = FreeRoamAudio.prototype.updateMarauderEngine;

  Object.defineProperty(FreeRoamAudio.prototype, "__eliteBoatAudioV12", {value: true});

  FreeRoamAudio.prototype.updateMarauderEngine = function updateEliteBoatEngine(world) {
    inheritedUpdateMarauderEngine.call(this, world);
    const elite = world?.freeEliteBoatBoss?.boat;
    if (!this.ctx || !this.marauderEngine || !this.listenerPoint || !elite?.active || elite.destroyed) return;
    const metres = distance(this.listenerPoint, elite);
    if (metres > 190) return;

    const engine = elite.engineAudio || {};
    const rpm = clamp(engine.rpm ?? Math.abs(Number(elite.speed) || 0) / Math.max(1, Number(elite.maxSpeed) || 23), 0, 1);
    const load = clamp(engine.load, 0, 1);
    const damage = clamp(engine.damage, 0, 1);
    const turnLoad = clamp(engine.turnLoad, 0, 1);
    const proximity = clamp(1 - metres / 190, 0, 1);
    const now = this.ctx.currentTime;

    let rate = 0.62 + rpm * 0.34;
    if (engine.state === "full-power") rate += 0.06;
    if (engine.state === "decelerating") rate -= 0.05;
    if (engine.state === "hard-turn") rate += 0.025 * turnLoad;
    if (engine.state === "damaged") rate -= 0.08 + damage * 0.07;
    this.marauderEngine.source.playbackRate.setTargetAtTime(clamp(rate, 0.48, 1.08), now, 0.13);

    const filter = 330 + proximity * 2450 + load * 520 - damage * 620;
    this.marauderEngine.filter.frequency.setTargetAtTime(clamp(filter, 260, 3900), now, 0.16);
    const gain = 0.012 + proximity * (0.13 + load * 0.055) + turnLoad * 0.018;
    this.marauderEngine.gain.gain.setTargetAtTime(clamp(gain, 0, 0.23), now, 0.16);
  };

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
