"use strict";

import "./free-roam-sharp-feedback-v1.js?v=1";
import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";

const prototype = FreeRoamAudio.prototype;

if (!prototype.__sharpActionCuesInstalled) {
  Object.defineProperty(prototype, "__sharpActionCuesInstalled", {value: true});
  const originalActionCue = prototype.playLocalActionCue;
  const originalLocalFeedback = prototype.updateLocalFeedback;

  prototype.playLocalActionCue = function playSharpLocalActionCue(kind = "action", suppressEvents = []) {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    this.localActionSuppressUntil ||= new Map();
    for (const eventType of suppressEvents || []) this.localActionSuppressUntil.set(eventType, now + 2);

    if (kind === "jump" || kind === "roof") {
      return this.playImmediateAction?.("jump", {
        mode: kind === "roof" ? "roof" : this.listenerPoint?.mode || "foot",
      }) ?? originalActionCue.call(this, kind, suppressEvents);
    }
    if (kind === "brake") {
      return this.playImmediateAction?.("brake") ?? originalActionCue.call(this, kind, suppressEvents);
    }
    if (["cargo-pickup", "cargo-stow", "cargo-drop"].includes(kind)) {
      return this.playImmediateAction?.("cargo", {cargoKind: kind}) ?? originalActionCue.call(this, kind, suppressEvents);
    }
    return originalActionCue.call(this, kind, suppressEvents);
  };

  prototype.updateLocalFeedback = function updateSharpLocalFeedback(world, playerIndex, input = {}) {
    const player = world?.players?.[playerIndex];
    const attacking = Boolean(input.attack);
    const previousAttacking = Boolean(this.__sharpPreviousAttackInput);
    if (
      attacking
      && !previousAttacking
      && player?.combat?.alive !== false
      && !player?.combat?.knockedDown
      && player?.combat?.equipped !== "automatic"
    ) {
      this.playImmediateAction?.("attack", {weapon: player?.combat?.equipped || "fists"});
    }
    this.__sharpPreviousAttackInput = attacking;
    return originalLocalFeedback.call(this, world, playerIndex, input);
  };
}
