"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function collisionSeverity(speed) {
  const knots = Math.abs(Number(speed) || 0);
  return clamp(0.35 + 0.72 * Math.pow(knots / 8, 2), 0.35, 4.6);
}

export function applyCollisionDamage(boat, rawDamage) {
  const damageMultiplier = clamp(Number(boat.collisionDamageMultiplier) || 1, 0.35, 2.5);
  const leakMultiplier = clamp(Number(boat.collisionLeakMultiplier) || 1, 0.35, 2.5);
  let damage = Math.max(0, Number(rawDamage) || 0) * damageMultiplier;
  let absorbed = 0;

  if (Number(boat.armor) > 0) {
    absorbed = Math.min(Number(boat.armor), damage * 0.48);
    boat.armor = Math.max(0, Number(boat.armor) - absorbed);
    damage -= absorbed;
  }

  boat.hull = clamp(Number(boat.hull) - damage, 0, 100);
  boat.leak = clamp(Number(boat.leak) + damage * 0.13 * leakMultiplier, 0, 16);
  return {damage, absorbed, armor: Number(boat.armor) || 0};
}
