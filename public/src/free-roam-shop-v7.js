"use strict";

import * as base from "./free-roam-shop-v6.js";

export * from "./free-roam-shop-v6.js";

const MEGA_BOMB_BATCH = 5;
const MEGA_BOMB_PRICE = 150;
const MEGA_BOMB_MAXIMUM = 45;

export const SHOP_ITEMS = Object.freeze(base.SHOP_ITEMS.map(item => item.id === "mega-bomb-charge"
  ? Object.freeze({...item, amount: MEGA_BOMB_BATCH, price: MEGA_BOMB_PRICE, maximum: MEGA_BOMB_MAXIMUM})
  : item));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function clampStock(value) {
  return Math.max(0, Math.min(MEGA_BOMB_MAXIMUM, Math.floor(Number(value) || 0)));
}

function stockFor(combat) {
  if (!combat) return 0;
  if (!Number.isFinite(Number(combat.megaBombStock))) {
    combat.megaBombStock = clampStock(
      Math.max(0, Math.floor(Number(combat.megaBombAmmo) || 0))
      + Math.max(0, Math.floor(Number(combat.megaBombReserve) || 0)),
    );
  }
  combat.megaBombStock = clampStock(combat.megaBombStock);
  combat.megaBombAmmo = Math.min(25, combat.megaBombStock);
  delete combat.megaBombReserve;
  return combat.megaBombStock;
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function description(world, playerIndex) {
  const state = base.ensureShopState(world);
  const stock = stockFor(world.players?.[playerIndex]?.combat);
  return `Заряды мега-бомбы. За покупку: ${MEGA_BOMB_BATCH}. Цена ${MEGA_BOMB_PRICE} кредитов. У тебя ${stock}. Максимум ${MEGA_BOMB_MAXIMUM}. Баланс команды ${state?.credits || 0}.`;
}

function patchShopEvents(world, startIndex = 0) {
  const events = world.events || [];
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.itemId !== "mega-bomb-charge") continue;
    if (!["shop-open", "shop-selection"].includes(event.type)) continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : Math.max(0, Number(event.targets?.[0]) || 0);
    const text = description(world, playerIndex);
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
    if (selected?.id !== "mega-bomb-charge" || !rising(input, previous, "shopBuy")) continue;

    const combat = world.players?.[index]?.combat;
    if (!combat) continue;
    const current = stockFor(combat);
    if (current + MEGA_BOMB_BATCH > MEGA_BOMB_MAXIMUM) {
      emit(world, "shop-denied", `Пять зарядов не помещаются. Сейчас у тебя ${current}, максимум ${MEGA_BOMB_MAXIMUM}.`, [index]);
    } else if (state.credits < MEGA_BOMB_PRICE) {
      emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${MEGA_BOMB_PRICE}, баланс команды ${state.credits}.`, [index]);
    } else {
      state.credits -= MEGA_BOMB_PRICE;
      combat.megaBombStock = current + MEGA_BOMB_BATCH;
      combat.megaBombAmmo = Math.min(25, combat.megaBombStock);
      delete combat.megaBombReserve;
      emit(world, "shop-purchased", `Куплено пять зарядов мега-бомбы. Теперь у тебя ${combat.megaBombStock}. Баланс команды ${state.credits}.`, [0, 1], {
        sourcePlayer: index,
        itemId: "mega-bomb-charge",
        price: MEGA_BOMB_PRICE,
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
