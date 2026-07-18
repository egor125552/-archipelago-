"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio} from "./free-roam-audio-v2.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export class FreeRoamAudio extends BaseFreeRoamAudio {
  constructor() {
    super();
    this.listenerPoint = null;
    this.localPlayerIndex = 0;
    this.walkAlternation = -1;
  }

  updateWorld(world, playerIndex) {
    this.localPlayerIndex = playerIndex;
    this.listenerPoint = world?.players?.[playerIndex] || null;
    super.updateWorld(world, playerIndex);
  }

  playSpatialMovement(event, playerIndex) {
    const sourceIsLocal = event.sourcePlayer === playerIndex;
    if (sourceIsLocal) {
      this.walkAlternation *= -1;
      const side = Number(event.movementPan) || 0;
      const pan = clamp(side * 0.58 + this.walkAlternation * (side ? 0.08 : 0.18), -0.85, 0.85);
      if (event.type === "swim-step") {
        this.play(this.buffers.has("waterSide") ? "waterSide" : "waterSoft", {
          gain: 0.31,
          rate: 0.9 + Math.random() * 0.1,
          pan,
          lowpass: 6500,
        });
      } else {
        this.playFootstep({gain: 0.23, rate: 0.94 + Math.random() * 0.12, pan});
      }
      return;
    }

    if (!this.listenerPoint) return;
    const metres = distance(this.listenerPoint, event);
    if (metres > 72) return;
    const proximity = clamp(1 - metres / 72, 0, 1);
    const pan = clamp(((Number(event.x) || 0) - (Number(this.listenerPoint.x) || 0)) / 42, -1, 1);
    if (event.type === "swim-step") {
      this.play(this.buffers.has("waterSide") ? "waterSide" : "waterSoft", {
        gain: 0.05 + proximity * 0.25,
        rate: 0.88 + Math.random() * 0.1,
        pan,
        lowpass: 4200 + proximity * 2500,
      });
    } else {
      this.playFootstep({
        gain: 0.035 + proximity * 0.2,
        rate: 0.92 + Math.random() * 0.12,
        pan,
      });
    }
  }

  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    if (["footstep", "swim-step"].includes(event.type) && Number.isInteger(event.sourcePlayer)) {
      this.playSpatialMovement(event, playerIndex);
      return;
    }
    super.handleFreeEvent(event, playerIndex);
  }
}
