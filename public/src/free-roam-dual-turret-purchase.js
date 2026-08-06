"use strict";

// Prototype access is deliberately isolated from the boat, weapons and physics.
// Replacing this module later restores a paid/owned vehicle without rewriting
// the physical boat or either installation.
export function ensureDualTurretPurchaseState(world) {
  world.freeDualTurretPurchase ||= {};
  const state = world.freeDualTurretPurchase;
  state.purchased = true;
  state.price = 0;
  state.purchasedBy = null;
  state.purchasedAt = 0;
  state.previousAction = Array.from({length: world.players?.length || 2}, () => false);
  state.lastDeniedAt = Array.from({length: world.players?.length || 2}, () => -999);
  state.prototypeAccess = true;
  return state;
}

export function prepareDualTurretPurchaseRoom(world) {
  return ensureDualTurretPurchaseState(world);
}

export function dualTurretPurchased(world) {
  return Boolean(ensureDualTurretPurchaseState(world).purchased);
}

export function prepareDualTurretPurchaseStep(world) {
  return {state: ensureDualTurretPurchaseState(world)};
}

export function finishDualTurretPurchaseStep() {}
