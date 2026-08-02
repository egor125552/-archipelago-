"use strict";

import * as base from "./free-roam-shop-v4.js";

export * from "./free-roam-shop-v4.js";

const MEGA_BOMB_BATCH = 30;
const MEGA_BOMB_PRICE = 120;
const MEGA_BOMB_MAXIMUM = 145;

export const SHOP_ITEMS = Object.freeze(base.SHOP_ITEMS.map(item => item.id === "mega-bomb-charge"
  ? Object.freeze({...item, amount: MEGA_BOMB_BATCH, price: MEGA_BOMB_PRICE, maximum: MEGA_BOMB_MAXIMUM})
  : item));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

export function updateMerchantShop(world) {
  const state = base.ensureShopState(world);
  if (!state) return base.updateMerchantShop(world);

  const suppressed = [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (!state.shopOpen?.[index]) continue;
    const selected = base.SHOP_ITEMS[state.shopSelection?.[index] || 0];
    const input = state.inputs?.[index];
    const previous = state.previousInputs?.[index];
    if (selected?.id !== "mega-bomb-charge" || !rising(input, previous, "shopBuy")) continue;

    const combat = world.players?.[index]?.combat;
    if (!combat) continue;
    const current = Math.max(0, Math.floor(Number(combat.megaBombAmmo) || 0));

    if (current + MEGA_BOMB_BATCH > MEGA_BOMB_MAXIMUM) {
      emit(world, "shop-denied", `Партия из ${MEGA_BOMB_BATCH} зарядов не помещается. Максимум ${MEGA_BOMB_MAXIMUM}, сейчас у тебя ${current}.`, [index]);
    } else if (state.credits < MEGA_BOMB_PRICE) {
      emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${MEGA_BOMB_PRICE}, баланс команды ${state.credits}.`, [index]);
    } else {
      state.credits -= MEGA_BOMB_PRICE;
      combat.megaBombAmmo = current + MEGA_BOMB_BATCH;
      emit(world, "shop-purchased", `Куплено 30 зарядов мега-бомбы. Теперь у тебя ${combat.megaBombAmmo}. Баланс команды ${state.credits}.`, [0, 1], {
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
}
