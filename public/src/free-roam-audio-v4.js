"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio, relativeMovementPan} from "./free-roam-audio-v3.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export class FreeRoamAudio extends BaseFreeRoamAudio {
  constructor() {
    super();
    this.spatialDiagnostics = {
      remotePan: 0,
      remoteGain: 0,
      remoteLowpass: 0,
      movementPan: 0,
      movementGain: 0,
      towPan: 0,
      towGain: 0,
    };
    globalThis.__freeRoamAudioDiagnostics = this.spatialDiagnostics;
  }

  updateRemote(world, playerIndex) {
    const me = world?.players?.[playerIndex];
    const other = world?.players?.[1 - playerIndex];
    const otherBoat = other && ["boat", "roof"].includes(other.mode) ? world.boats?.[other.activeBoat] : null;
    const metres = me && otherBoat ? distance(me, otherBoat) : Infinity;
    const pan = me && otherBoat ? relativeMovementPan(me, otherBoat) : 0;
    const proximity = clamp(1 - metres / 175, 0, 1);
    const shaped = proximity * proximity;
    const speed = Math.abs(Number(otherBoat?.speed) || 0);
    const throttle = Math.abs(Number(otherBoat?.throttle) || 0);
    const lowpass = 900 + shaped * 5200 + clamp(speed / 18, 0, 1) * 900;
    const engineGain = otherBoat?.engineStalled ? 0 : shaped * (0.025 + throttle * 0.15);
    const wakeGain = speed < 0.35 ? 0 : shaped * (0.018 + speed / 135);

    Object.assign(this.spatialDiagnostics, {
      remotePan: pan,
      remoteGain: engineGain,
      remoteLowpass: lowpass,
    });

    if (!this.ctx || !me || !otherBoat || otherBoat.sunk || metres >= 175) {
      if (this.ctx && this.remote) this.remote.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.16);
      if (this.ctx && this.remoteWake) this.remoteWake.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.16);
      return;
    }

    this.startRemoteLoop("remote", "motorboatReal");
    this.startRemoteLoop("remoteWake", this.buffers.has("riverWake") ? "riverWake" : "seaReal");
    const now = this.ctx.currentTime;
    if (this.remote) {
      this.remote.source.playbackRate.setTargetAtTime(0.9 + throttle * 0.17, now, 0.1);
      this.remote.filter.frequency.setTargetAtTime(lowpass, now, 0.14);
      this.remote.panner.pan.setTargetAtTime(pan, now, 0.1);
      this.remote.gain.gain.setTargetAtTime(engineGain, now, 0.15);
    }
    if (this.remoteWake) {
      this.remoteWake.source.playbackRate.setTargetAtTime(0.84 + clamp(speed / 18, 0, 1) * 0.19, now, 0.12);
      this.remoteWake.filter.frequency.setTargetAtTime(lowpass + 900, now, 0.14);
      this.remoteWake.panner.pan.setTargetAtTime(pan, now, 0.1);
      this.remoteWake.gain.gain.setTargetAtTime(wakeGain, now, 0.15);
    }
  }

  playSpatialMovement(event, playerIndex) {
    const local = event.sourcePlayer === playerIndex;
    const listener = this.listenerPoint;
    let pan = 0;
    let gain = event.running ? 0.29 : 0.22;
    if (local) {
      this.walkAlternation *= -1;
      const side = Number(event.movementPan) || 0;
      pan = clamp(side * 0.56 + this.walkAlternation * (side ? 0.08 : 0.17), -0.88, 0.88);
    } else {
      if (!listener) return;
      const metres = distance(listener, event);
      if (metres > 82) return;
      const proximity = clamp(1 - metres / 82, 0, 1);
      pan = relativeMovementPan(listener, event);
      gain = (event.running ? 0.055 : 0.035) + proximity * (event.running ? 0.25 : 0.2);
    }

    this.spatialDiagnostics.movementPan = pan;
    this.spatialDiagnostics.movementGain = gain;
    if (event.type === "swim-step") {
      this.play(this.buffers.has("waterSide") ? "waterSide" : "waterSoft", {
        gain,
        rate: 0.88 + Math.random() * 0.1,
        pan,
        lowpass: local ? 6500 : 4700,
      });
      return;
    }
    this.playFootstep({
      gain,
      rate: event.running ? 1.12 + Math.random() * 0.1 : 0.94 + Math.random() * 0.12,
      pan,
    });
  }

  eventPan(event) {
    if (!this.listenerPoint || !Number.isFinite(event?.x) || !Number.isFinite(event?.y)) return Number(event?.pan) || 0;
    return relativeMovementPan(this.listenerPoint, event);
  }

  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    if (["footstep", "swim-step"].includes(event.type) && Number.isInteger(event.sourcePlayer)) {
      this.playSpatialMovement(event, playerIndex);
      return;
    }

    if (event.type === "landing") {
      const pan = this.eventPan(event);
      const local = event.sourcePlayer === playerIndex;
      this.playFootstep({gain: local ? 0.34 : 0.18, rate: 0.82, pan});
      if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: local ? 0.11 : 0.06, rate: 1.1, pan, lowpass: 3800});
      return;
    }

    if (event.type === "boundary" || event.type === "water-boundary") {
      const pan = this.eventPan(event);
      if (event.type === "water-boundary") {
        this.play(this.buffers.has("waterHeavy") ? "waterHeavy" : "waterSoft", {gain: 0.2, rate: 0.78, pan, lowpass: 3600});
      } else if (this.buffers.has("hullCreak")) {
        this.play("hullCreak", {gain: 0.16, rate: 0.76, pan, lowpass: 3200});
      }
      return;
    }

    if (event.type === "tow-creak" || event.type === "tow-strain") {
      const pan = this.eventPan(event);
      const tension = clamp(Number(event.tension) || 0, 0, 1.45);
      const gain = 0.08 + tension * 0.18;
      this.spatialDiagnostics.towPan = pan;
      this.spatialDiagnostics.towGain = gain;
      if (event.type === "tow-strain") {
        this.handle([{type: "rope-strain", speed: tension, pan}]);
      } else if (this.buffers.has("hullCreak")) {
        this.play("hullCreak", {gain, rate: 0.74 + tension * 0.16, pan, lowpass: 3000 + tension * 2200});
      }
      return;
    }

    super.handleFreeEvent(event, playerIndex);
  }
}
