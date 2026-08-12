"use strict";

import * as base from "./free-roam-shop-v12.js?v=1";

export * from "./free-roam-shop-v12.js?v=1";
export const SHOP_ITEMS = base.SHOP_ITEMS;

function withLegacyNullBoatSlots(world, action) {
  const boats = world?.boats;
  if (!Array.isArray(boats)) return action();
  const replaced = [];
  for (let index = 0; index < boats.length; index += 1) {
    if (boats[index] != null) continue;
    replaced.push({index, hadValue: Object.prototype.hasOwnProperty.call(boats, index), value: boats[index]});
    boats[index] = {
      id: index,
      owner: null,
      driver: null,
      crew: [],
      sunk: true,
      shopEligible: false,
      __emptyBoatSlot: true,
    };
  }
  try {
    return action();
  } finally {
    for (const slot of replaced) {
      if (slot.hadValue) boats[slot.index] = slot.value;
      else delete boats[slot.index];
    }
  }
}

function keepBoatChooserFocused(world, startIndex) {
  const fresh = (world?.events || []).slice(startIndex);
  const chooserPlayers = new Set(
    fresh
      .filter(event => event?.type === "shop-boat-selection-open" && Number.isInteger(event.sourcePlayer))
      .map(event => event.sourcePlayer),
  );
  if (!chooserPlayers.size) return;
  const kept = fresh.filter(event => !(event?.type === "merchant-ready" && chooserPlayers.has(event.sourcePlayer)));
  world.events.splice(startIndex, fresh.length, ...kept);
}

export function handleMerchantAction(world, playerIndex) {
  return withLegacyNullBoatSlots(world, () => base.handleMerchantAction(world, playerIndex));
}

export function updateMerchantShop(world) {
  return withLegacyNullBoatSlots(world, () => {
    const startIndex = world?.events?.length || 0;
    const result = base.updateMerchantShop(world);
    keepBoatChooserFocused(world, startIndex);
    return result;
  });
}
