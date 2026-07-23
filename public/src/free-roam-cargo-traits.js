"use strict";

export function contractTraits(crate) {
  return Array.isArray(crate?.traits) ? crate.traits : [];
}

export function hasContractTrait(crate, trait) {
  return contractTraits(crate).includes(trait);
}

export function cargoSlotCost(crate) {
  return Math.max(1, Number(crate?.slots) || (hasContractTrait(crate, "twoSlots") ? 2 : 1));
}

export function damageFragileCargo(crate, impact) {
  if (!hasContractTrait(crate, "fragile") || crate?.contractDamage >= 100) return false;
  const amount = Math.max(0, Number(impact) || 0);
  if (amount < 8) return false;
  crate.contractDamage = Math.min(100, (Number(crate.contractDamage) || 0) + amount * 1.6);
  return true;
}

export function contractBonusMultiplier(crate) {
  const damage = Math.max(0, Math.min(100, Number(crate?.contractDamage) || 0));
  return Math.max(0.25, 1 - damage / 120);
}

export function waterExposureTick(crate, dt) {
  if (!hasContractTrait(crate, "waterSensitive") || crate?.state !== "world") return false;
  if ((Number(crate?.y) || 0) < 80) return false;
  crate.waterExposure = Math.max(0, (Number(crate.waterExposure) || 0) + Math.max(0, Number(dt) || 0));
  return true;
}
