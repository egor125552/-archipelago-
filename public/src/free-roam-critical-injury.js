"use strict";

export const CRITICAL_HEALTH = 7;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function isCriticalHealth(health) {
  const value = Number(health);
  return Number.isFinite(value) && value > 0 && value <= CRITICAL_HEALTH;
}

export function criticalInjuryMix(combat) {
  if (!combat?.alive) return 1;
  const health = clamp(Number(combat.health) || 0, 0, 100);
  return clamp((100 - health) / (100 - CRITICAL_HEALTH), 0, 1);
}
