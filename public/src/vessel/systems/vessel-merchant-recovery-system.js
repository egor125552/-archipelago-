"use strict";

import {
  DOCK_BOAT_MAX_X,
  DOCK_BOAT_MAX_Y,
  DOCK_BOAT_MIN_X,
  isBoatDockPosition,
} from "../../free-roam-cargo-rules.js?v=32";

const LOCKED_RECOVERY_TIMER = Number.MAX_SAFE_INTEGER;
const MERCHANT_RECOVERY_HULL_FRACTION = 0.2;

function armoredLegacyPair(world) {
  const controller = world?.freeDualTurretBoat;
  const boatId = Number.isInteger(controller?.boatId) ? controller.boatId : null;
  const boat = boatId == null ? null : world?.boats?.[boatId] || null;
  return controller && boat ? {controller, boat} : null;
}

function unlockRecoverableNativeEngines({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    const boat = entry?.boat;
    const engine = entry?.instance?.modules?.engine;
    const waterBridge = entry?.instance?.interior?.waterBridge;
    if (!boat || !engine || !waterBridge?.floodStalled || boat.sunk) continue;
    if (waterBridge.floodDisabledModules?.engine) continue;
    if (engine.repairActive) continue;
    if ((Number(engine.health) || 0) <= 0) continue;

    // A merchant recovery marks the engine as stalled while preserving a
    // minimum operable module health. Older recovery code also left the module
    // disabled, which converted "stalled" into an impossible permanent repair
    // requirement. Re-enable only this recoverable-stall state; the flooding
    // authority still owns the timed restart and all genuine damage gates.
    if (engine.enabled === false) engine.enabled = true;
  }
}

function prepareRecoveryLifecycle(context = {}) {
  const {world} = context;
  unlockRecoverableNativeEngines(context);
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

function berthCandidates() {
  const minX = Number(DOCK_BOAT_MIN_X) || 148;
  const maxX = Number(DOCK_BOAT_MAX_X) || 272;
  const maxY = Number(DOCK_BOAT_MAX_Y) || 98;
  const middleX = (minX + maxX) / 2;
  return [
    {x: maxX - 12, y: maxY - 6},
    {x: minX + 12, y: maxY - 6},
    {x: middleX, y: maxY - 6},
    {x: maxX - 38, y: maxY - 20},
    {x: minX + 38, y: maxY - 20},
  ];
}

function berthClearance(world, boat, candidate) {
  let clearance = Infinity;
  for (const other of world?.boats || []) {
    if (!other || other.id === boat.id || other.sunk) continue;
    const metres = Math.hypot(
      (Number(other.x) || 0) - candidate.x,
      (Number(other.y) || 0) - candidate.y,
    );
    const required = Math.max(4, Number(other.collisionRadius) || 6) + Math.max(4, Number(boat.collisionRadius) || 6);
    clearance = Math.min(clearance, metres - required);
  }
  return clearance;
}

function ensureMerchantServiceBerth(world, boat, event) {
  if (isBoatDockPosition(boat)) return;
  const candidates = berthCandidates()
    .filter(candidate => isBoatDockPosition({...boat, ...candidate, sunk: false}))
    .sort((left, right) => berthClearance(world, boat, right) - berthClearance(world, boat, left));
  const berth = candidates[0];
  if (!berth) return;
  boat.x = berth.x;
  boat.y = berth.y;
  boat.heading = 0;
  if (event) {
    event.x = boat.x;
    event.y = boat.y;
    event.serviceBerth = true;
  }
}

function rememberRecoveredServiceTarget(world, event, boat) {
  const playerIndex = Number.isInteger(event?.sourcePlayer) ? event.sourcePlayer : null;
  const player = playerIndex == null ? null : world?.players?.[playerIndex];
  if (player) player.lastBoatId = boat.id;
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

    // Merchant recovery is a service transition. Native vessels may have a
    // gameplay home outside the merchant dock; using that home would make the
    // freshly recovered vessel impossible to service even though the recovery
    // message says it is at the pier. Guarantee a real service berth instead.
    ensureMerchantServiceBerth(world, boat, event);
    rememberRecoveredServiceTarget(world, event, boat);
    boat.fleetService = true;

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

    const engine = entry.instance?.modules?.engine;
    const waterBridge = entry.instance?.interior?.waterBridge;
    if (
      engine
      && (Number(engine.health) || 0) > 0
      && !waterBridge?.floodDisabledModules?.engine
      && !engine.repairActive
    ) {
      engine.enabled = true;
    }
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
    id: "vessel-manual-merchant-recovery-before-step-v2",
    phase: "before-step",
    order: -80,
    run: prepareRecoveryLifecycle,
  }),
  Object.freeze({
    id: "vessel-manual-merchant-recovery-after-step-v3",
    phase: "after-step",
    order: 90,
    run: rewriteLegacyRecoveryEvents,
  }),
]);
