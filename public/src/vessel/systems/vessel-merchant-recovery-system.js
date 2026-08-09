"use strict";

const LOCKED_RECOVERY_TIMER = Number.MAX_SAFE_INTEGER;
const MERCHANT_RECOVERY_HULL_FRACTION = 0.2;

function armoredLegacyPair(world) {
  const controller = world?.freeDualTurretBoat;
  const boatId = Number.isInteger(controller?.boatId) ? controller.boatId : null;
  const boat = boatId == null ? null : world?.boats?.[boatId] || null;
  return controller && boat ? {controller, boat} : null;
}

function lockLegacyAutomaticRecovery({world} = {}) {
  const pair = armoredLegacyPair(world);
  if (!pair) return;
  const {controller, boat} = pair;
  boat.fleetService = true;
  boat.manualRecoveryOnly = true;
  if (!boat.sunk) return;
  controller.recoveryRemaining = LOCKED_RECOVERY_TIMER;
  controller.recoveryWarned30 = true;
  controller.recoveryWarned10 = true;
}

function nativeEntryForBoat(nativeVessels, boatId) {
  return (nativeVessels || []).find(entry => entry?.boat?.id === boatId) || null;
}

function reconcileNativeMerchantRecovery({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const events = world.events || [];
  const recoveries = events.slice(eventStart).filter(event => (
    event?.type === "wreck-recovery-complete"
    && Number.isInteger(event.boatId)
  ));
  if (!recoveries.length) return;

  const recoveredBoatIds = new Set();
  for (const event of recoveries) {
    const entry = nativeEntryForBoat(nativeVessels, event.boatId);
    const boat = entry?.boat;
    if (!boat || boat.sunk) continue;
    recoveredBoatIds.add(boat.id);

    // The legacy merchant performs the explicit sunk -> recovered transition
    // during the masked legacy step. The vessel flooding authority must not
    // overwrite that transition with the pre-step wreck snapshot (hull 0).
    // Reassert the merchant recovery contract at the architecture boundary.
    if ((Number(boat.hull) || 0) <= 0.05) {
      const hullMax = Math.max(1, Number(boat.hullMax) || 100);
      boat.hull = Math.max(1, hullMax * MERCHANT_RECOVERY_HULL_FRACTION);
    }
    boat.emergencyActive = false;
    boat.emergencyRemaining = 0;
    boat.emergencyWarned15 = false;
    boat.emergencyWarned5 = false;
    boat.speed = 0;
    boat.throttle = 0;
    boat.rudder = 0;
    boat.engineStalled = true;
  }

  if (!recoveredBoatIds.size) return;

  // A zero-hull snapshot can make the flooding authority emit an emergency in
  // the same tick as a valid merchant recovery. That emergency is an artifact
  // of the stale snapshot and must never be announced or carried forward.
  for (let index = events.length - 1; index >= eventStart; index -= 1) {
    const event = events[index];
    if (
      event?.type === "flood-emergency-start"
      && recoveredBoatIds.has(event.boatId)
    ) {
      events.splice(index, 1);
    }
  }
}

function rewriteLegacyRecoveryEvents(context = {}) {
  const {world, eventStart = 0} = context;
  reconcileNativeMerchantRecovery(context);

  const pair = armoredLegacyPair(world);
  if (!pair) return;
  const {controller, boat} = pair;
  boat.fleetService = true;
  boat.manualRecoveryOnly = true;
  if (boat.sunk) {
    controller.recoveryRemaining = LOCKED_RECOVERY_TIMER;
    controller.recoveryWarned30 = true;
    controller.recoveryWarned10 = true;
  }
  for (const event of (world.events || []).slice(eventStart)) {
    if (event?.boatId !== boat.id) continue;
    if (event.type === "dual-turret-recovery-start") {
      event.type = "vessel-manual-recovery-required";
      event.text = `${boat.label || "Бронекатер"} затонул. Автоматического восстановления больше нет: выбери аварийный подъём у торговца и, если доступно несколько лодок, укажи нужную.`;
      event.seconds = null;
      event.manualRecoveryOnly = true;
    } else if (event.type === "dual-turret-recovery-warning") {
      event.type = "vessel-manual-recovery-required";
      event.text = `${boat.label || "Бронекатер"} остаётся затонувшим до аварийного подъёма у торговца.`;
      event.seconds = null;
      event.manualRecoveryOnly = true;
    }
  }
}

export const VESSEL_MERCHANT_RECOVERY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-manual-merchant-recovery-before-step-v1",
    phase: "before-step",
    order: -80,
    run: lockLegacyAutomaticRecovery,
  }),
  Object.freeze({
    id: "vessel-manual-merchant-recovery-after-step-v2",
    phase: "after-step",
    order: 90,
    run: rewriteLegacyRecoveryEvents,
  }),
]);
