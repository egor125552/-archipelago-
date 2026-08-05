"use strict";

import * as base from "./free-roam-shop-v7.js";

export * from "./free-roam-shop-v7.js";

export const AUTOMATIC_WEAPON_PRICE = 120;
export const SHOP_ITEMS = base.SHOP_ITEMS;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function lacksAutomatic(world, playerIndex) {
  return !world.players?.[playerIndex]?.combat?.weapons?.automatic;
}

function automaticDescription(world, playerIndex) {
  const state = base.ensureShopState(world);
  const ammo = Math.max(0, Math.floor(Number(world.players?.[playerIndex]?.combat?.ammo) || 0));
  return `Автомат. Цена ${AUTOMATIC_WEAPON_PRICE} кредитов. После покупки он сразу добавится тебе и будет выбран. Уже купленные патроны сохранятся: сейчас ${ammo}. Баланс команды ${state?.credits || 0}.`;
}

function patchShopEvents(world, startIndex = 0) {
  const events = world.events || [];
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.itemId !== "automatic-ammo") continue;
    if (!["shop-open", "shop-selection"].includes(event.type)) continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : Math.max(0, Number(event.targets?.[0]) || 0);
    if (!lacksAutomatic(world, playerIndex)) continue;
    const text = automaticDescription(world, playerIndex);
    event.text = event.type === "shop-open"
      ? `Магазин открыт. ${text} Листай товары, сервис и постоянные улучшения.`
      : text;
  }
}

export function handleMerchantAction(world, playerIndex) {
  const startIndex = world.events?.length || 0;
  const opened = base.handleMerchantAction(world, playerIndex);
  patchShopEvents(world, startIndex);
  return opened;
}

export function updateMerchantShop(world) {
  const state = base.ensureShopState(world);
  if (!state) return base.updateMerchantShop(world);
  const startIndex = world.events?.length || 0;
  const suppressed = [];

  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (!state.shopOpen?.[index]) continue;
    const selected = base.SHOP_ITEMS[state.shopSelection?.[index] || 0];
    const input = state.inputs?.[index];
    const previous = state.previousInputs?.[index];
    if (selected?.id !== "automatic-ammo" || !rising(input, previous, "shopBuy")) continue;

    const combat = world.players?.[index]?.combat;
    if (!combat || !lacksAutomatic(world, index)) continue;

    if (state.credits < AUTOMATIC_WEAPON_PRICE) {
      emit(world, "shop-denied", `Недостаточно кредитов для автомата. Нужно ${AUTOMATIC_WEAPON_PRICE}, баланс команды ${state.credits}.`, [index], {
        sourcePlayer: index,
        itemId: "automatic-weapon",
      });
    } else {
      state.credits -= AUTOMATIC_WEAPON_PRICE;
      combat.weapons ||= {};
      combat.weapons.automatic = true;
      combat.equipped = "automatic";
      if (!Number.isFinite(Number(combat.ammo))) combat.ammo = 0;
      emit(world, "shop-purchased", `Куплен автомат. Он добавлен тебе и выбран. Патронов ${Math.max(0, Math.floor(Number(combat.ammo) || 0))}. Баланс команды ${state.credits}.`, [0, 1], {
        sourcePlayer: index,
        itemId: "automatic-weapon",
        price: AUTOMATIC_WEAPON_PRICE,
        credits: state.credits,
        x: base.MERCHANT.x,
        y: base.MERCHANT.y,
      });
    }

    if (input) {
      suppressed.push([input, input.shopBuy]);
      input.shopBuy = false;
    }
  }

  base.updateMerchantShop(world);
  for (const [input, value] of suppressed) input.shopBuy = value;
  patchShopEvents(world, startIndex);
}
