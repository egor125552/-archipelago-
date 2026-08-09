"use strict";

import * as base from "./free-roam-shop-v11.js?v=1";
import {nativeVesselForBoat} from "./vessel/vessel-runtime.js?v=2";

export * from "./free-roam-shop-v11.js?v=1";
export const SHOP_ITEMS = base.SHOP_ITEMS;

function finishVesselRecovery(world, event) {
  if (!Number.isInteger(event?.boatId)) return;
  if (!["wreck-recovery-complete", "shop-service-complete"].includes(event.type)) return;
  const entry = nativeVesselForBoat(world, event.boatId);
  if (!entry?.instance) return;

  const recovery = event.type === "wreck-recovery-complete";
  const targetWater = recovery
    ? Math.max(0, Math.min(100, Number(entry.boat?.water) || 0))
    : 0;

  // Recovery is a stable state transition, not merely a visual reset. Any
  // compartment breach left by the previous life must be closed, otherwise a
  // freshly serviced vessel immediately starts filling again on the next tick.
  for (const zone of Object.values(entry.instance.zones || {})) {
    zone.leakRate = 0;
    if (!recovery) zone.flooding = 0;
  }
  entry.boat.leak = 0;
  entry.boat.water = targetWater;

  if (entry.instance.interior) {
    entry.instance.interior.waterBridge ||= {};
    Object.assign(entry.instance.interior.waterBridge, {
      authorityVersion: 2,
      initialized: true,
      lastAggregate: targetWater,
      floodDisabledModules: {},
      floodStalled: recovery,
      damageAccumulator: {},
    });
  }
}

function patchRecoveryEvents(world, startIndex) {
  for (const event of (world?.events || []).slice(startIndex)) finishVesselRecovery(world, event);
}

export function handleMerchantAction(world, playerIndex) {
  return base.handleMerchantAction(world, playerIndex);
}

export function updateMerchantShop(world) {
  const startIndex = world?.events?.length || 0;
  const result = base.updateMerchantShop(world);
  patchRecoveryEvents(world, startIndex);
  return result;
}
