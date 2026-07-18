"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const HEALTH_RECOVERY_DELAY = 6;
export const HEALTH_RECOVERY_RATE = 2.5;

export function injuryLowpassFrequency(mix) {
  return 12000 - clamp(Number(mix) || 0, 0, 1) * 9300;
}

export function ensureRecoveryState(combat) {
  if (!Number.isFinite(combat.lastDamageAt)) combat.lastDamageAt = -999;
  if (typeof combat.recoveryStarted !== "boolean") combat.recoveryStarted = false;
}

export function registerCombatDamage(combat, worldTime) {
  ensureRecoveryState(combat);
  combat.lastDamageAt = Number(worldTime) || 0;
  combat.recoveryStarted = false;
}

export function updateCombatRecovery(combat, worldTime, dt) {
  ensureRecoveryState(combat);
  if (!combat.alive || combat.health >= 100 || worldTime - combat.lastDamageAt < HEALTH_RECOVERY_DELAY) {
    return null;
  }
  const started = !combat.recoveryStarted;
  combat.recoveryStarted = true;
  combat.health = clamp(combat.health + HEALTH_RECOVERY_RATE * dt, 0, 100);
  if (combat.health >= 100) {
    combat.health = 100;
    combat.recoveryStarted = false;
    return "complete";
  }
  return started ? "started" : null;
}

export function injuryMixTarget(combat) {
  if (!combat?.alive) return 1;
  const healthInjury = clamp((80 - combat.health) / 55, 0, 1);
  const stunInjury = clamp(combat.stun / 55, 0, 1);
  const knockdownInjury = combat.knockedDown ? 0.82 : 0;
  return Math.max(healthInjury, stunInjury, knockdownInjury);
}
