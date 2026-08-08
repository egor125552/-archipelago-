"use strict";

const LOCKED_RECOVERY_TIMER = Number.MAX_SAFE_INTEGER;

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

function rewriteLegacyRecoveryEvents({world, eventStart = 0} = {}) {
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
    id: "vessel-manual-merchant-recovery-after-step-v1",
    phase: "after-step",
    order: 90,
    run: rewriteLegacyRecoveryEvents,
  }),
]);
