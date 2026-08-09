"use strict";

import * as base from "./free-roam-shop-v10.js?v=1";
import {isBoatDockPosition} from "./free-roam-cargo-rules.js?v=32";
import {nativeVesselForBoat} from "./vessel/vessel-runtime.js?v=2";

export * from "./free-roam-shop-v10.js?v=1";
export const SHOP_ITEMS = base.SHOP_ITEMS;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 220) world.events.splice(0, world.events.length - 220);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function ensureFleetSelectionState(world) {
  const state = base.ensureShopState(world);
  if (!state) return null;
  state.boatTargetSelection ||= Array.from({length: world.players?.length || 2}, () => null);
  while (state.boatTargetSelection.length < (world.players?.length || 0)) state.boatTargetSelection.push(null);
  return state;
}

function legacyShopWorld(world) {
  const boats = world?.boats || [];
  if (!boats.some(boat => boat == null)) return world;
  // Older shop layers dereference boat.owner without a null check. Preserve
  // physical boat indices and real object identity while giving only those
  // legacy lookups inert placeholders for empty fleet slots.
  world.events ||= [];
  return {
    ...world,
    boats: boats.map((boat, index) => boat || {
      id: index,
      owner: null,
      driver: null,
      crew: [],
      sunk: true,
      shopEligible: false,
      x: -100000,
      y: -100000,
    }),
  };
}

function teamFleetBoat(boat) {
  if (!boat || boat.shopEligible === false) return false;
  if (boat.fleetService === true) return true;
  if (Number.isInteger(boat.owner) || Number.isInteger(boat.driver)) return true;
  return Array.isArray(boat.crew) && boat.crew.some(Number.isInteger);
}

function candidatesForItem(world, item) {
  const boats = (world.boats || []).filter(teamFleetBoat);
  if (item?.wreckService) return boats.filter(boat => boat.sunk);
  if (item?.boatItem) return boats.filter(boat => !boat.sunk && isBoatDockPosition(boat));
  return [];
}

function boatCondition(boat, item) {
  if (!boat) return "";
  if (item?.wreckService) return "затонула";
  return `корпус ${Math.round(Number(boat.hull) || 0)} из ${Math.round(Number(boat.hullMax) || 100)}, вода ${Math.round(Number(boat.water) || 0)} процентов`;
}

function selectionText(world, playerIndex, selection) {
  const item = SHOP_ITEMS.find(candidate => candidate.id === selection.itemId);
  const boatId = selection.boatIds[selection.index] ?? null;
  const boat = Number.isInteger(boatId) ? world.boats?.[boatId] : null;
  const number = selection.index + 1;
  const total = selection.boatIds.length;
  return `Выберите лодку. ${number} из ${total}: ${boat?.label || "лодка"}, ${boatCondition(boat, item)}. Вверх и вниз — выбрать, действие — подтвердить, назад — вернуться к товару.`;
}

function openBoatSelection(world, playerIndex, item, boatIds) {
  const state = ensureFleetSelectionState(world);
  state.boatTargetSelection[playerIndex] = {itemId: item.id, boatIds: [...boatIds], index: 0};
  emit(world, "shop-boat-selection-open", selectionText(world, playerIndex, state.boatTargetSelection[playerIndex]), [playerIndex], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    boatId: boatIds[0] ?? null,
    choices: boatIds.length,
    x: base.MERCHANT.x,
    y: base.MERCHANT.y,
  });
}

function suppress(input, saved, keys) {
  if (!input) return;
  for (const key of keys) {
    saved.push([input, key, input[key]]);
    input[key] = false;
  }
}

function restoreSuppressed(saved) {
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    const [input, key, value] = saved[index];
    input[key] = value;
  }
}

function normalizeSelectionIndex(selection) {
  const length = selection.boatIds.length;
  if (!length) return 0;
  return ((Math.floor(Number(selection.index) || 0) % length) + length) % length;
}

function processBoatSelection(world, playerIndex, state, input, previous, saved) {
  const selection = state.boatTargetSelection[playerIndex];
  if (!selection) return false;
  if (!state.shopOpen?.[playerIndex]) {
    state.boatTargetSelection[playerIndex] = null;
    return false;
  }

  const close = rising(input, previous, "shopClose");
  const previousBoat = rising(input, previous, "shopPrevious");
  const nextBoat = rising(input, previous, "shopNext");
  const buy = rising(input, previous, "shopBuy");

  if (close) {
    state.boatTargetSelection[playerIndex] = null;
    emit(world, "shop-boat-selection-closed", "Выбор лодки закрыт. Возврат к выбранной услуге.", [playerIndex], {
      sourcePlayer: playerIndex,
      itemId: selection.itemId,
      x: base.MERCHANT.x,
      y: base.MERCHANT.y,
    });
    suppress(input, saved, ["shopClose", "shopPrevious", "shopNext", "shopBuy"]);
    return true;
  }

  if (previousBoat || nextBoat) {
    selection.index = normalizeSelectionIndex({...selection, index: selection.index + (previousBoat ? -1 : 1)});
    emit(world, "shop-boat-selection", selectionText(world, playerIndex, selection), [playerIndex], {
      sourcePlayer: playerIndex,
      itemId: selection.itemId,
      boatId: selection.boatIds[selection.index] ?? null,
      selection: selection.index,
      choices: selection.boatIds.length,
      x: base.MERCHANT.x,
      y: base.MERCHANT.y,
    });
    suppress(input, saved, ["shopClose", "shopPrevious", "shopNext", "shopBuy"]);
    return true;
  }

  if (buy) {
    const boatId = selection.boatIds[normalizeSelectionIndex(selection)] ?? null;
    if (Number.isInteger(boatId)) {
      const player = world.players?.[playerIndex];
      if (player) player.lastBoatId = boatId;
      emit(world, "shop-boat-selection-confirmed", `Выбрана лодка: ${world.boats?.[boatId]?.label || "лодка"}.`, [playerIndex], {
        sourcePlayer: playerIndex,
        itemId: selection.itemId,
        boatId,
        x: base.MERCHANT.x,
        y: base.MERCHANT.y,
      });
    }
    state.boatTargetSelection[playerIndex] = null;
    suppress(input, saved, ["shopClose", "shopPrevious", "shopNext"]);
    return true;
  }

  suppress(input, saved, ["shopClose", "shopPrevious", "shopNext", "shopBuy"]);
  return true;
}

function architectureRecoveryState(world, event) {
  if (!Number.isInteger(event?.boatId)) return;
  const entry = nativeVesselForBoat(world, event.boatId);
  if (!entry?.instance) return;
  const recovery = event.type === "wreck-recovery-complete";
  const fullService = event.type === "shop-service-complete";
  if (!recovery && !fullService) return;

  const targetWater = fullService ? 0 : Math.max(0, Math.min(100, Number(entry.boat.water) || 0));
  for (const zone of Object.values(entry.instance.zones || {})) {
    zone.flooding = targetWater;
    zone.fire = 0;
    zone.health = fullService ? 100 : Math.max(35, Number(zone.health) || 0);
  }
  for (const [moduleId, module] of Object.entries(entry.instance.modules || {})) {
    const definition = (entry.definition.modules || []).find(candidate => candidate.id === moduleId);
    if (fullService) {
      module.health = 100;
      module.enabled = true;
    } else {
      module.health = Math.max(35, Number(module.health) || 0);
      module.enabled = definition?.type === "propulsion" ? false : module.health > 0;
    }
  }
  entry.instance.occupants = {};
  if (entry.instance.interior) {
    entry.instance.interior.claims = {};
    entry.instance.interior.traversals = {};
    if (entry.instance.interior.waterBridge) {
      entry.instance.interior.waterBridge.initialized = true;
      entry.instance.interior.waterBridge.lastAggregate = targetWater;
      entry.instance.interior.waterBridge.floodDisabledModules = {};
      entry.instance.interior.waterBridge.floodStalled = recovery;
    }
  }
}

function patchArchitectureRecovery(world, startIndex) {
  for (const event of (world.events || []).slice(startIndex)) architectureRecoveryState(world, event);
}

export function handleMerchantAction(world, playerIndex) {
  const state = ensureFleetSelectionState(world);
  if (state) state.boatTargetSelection[playerIndex] = null;
  return base.handleMerchantAction(legacyShopWorld(world), playerIndex);
}

export function updateMerchantShop(world) {
  const state = ensureFleetSelectionState(world);
  if (!state) return base.updateMerchantShop(legacyShopWorld(world));
  const startIndex = world.events?.length || 0;
  const saved = [];

  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    if (!state.shopOpen?.[playerIndex]) {
      state.boatTargetSelection[playerIndex] = null;
      continue;
    }
    const input = state.inputs?.[playerIndex];
    const previous = state.previousInputs?.[playerIndex];
    if (processBoatSelection(world, playerIndex, state, input, previous, saved)) continue;

    const item = SHOP_ITEMS[state.shopSelection?.[playerIndex] || 0];
    if (!item || (!item.boatItem && !item.wreckService) || !rising(input, previous, "shopBuy")) continue;
    const candidates = candidatesForItem(world, item);
    if (candidates.length > 1) {
      openBoatSelection(world, playerIndex, item, candidates.map(boat => boat.id));
      suppress(input, saved, ["shopBuy", "shopPrevious", "shopNext", "shopClose"]);
    } else if (candidates.length === 1) {
      const player = world.players?.[playerIndex];
      if (player) player.lastBoatId = candidates[0].id;
    }
  }

  base.updateMerchantShop(legacyShopWorld(world));
  restoreSuppressed(saved);
  patchArchitectureRecovery(world, startIndex);
}
