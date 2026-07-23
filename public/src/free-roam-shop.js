"use strict";

import {isBoatDockPosition} from "./free-roam-cargo-rules.js?v=32";

export const MERCHANT = Object.freeze({
  id: "merchant",
  kind: "merchant",
  label: "торговый причал",
  x: 210,
  y: 58,
});
export const MERCHANT_ACTION_RANGE = 9;
export const MERCHANT_AUDIO_RANGE = 35;

export const SHOP_ITEMS = Object.freeze([
  Object.freeze({id: "pistol-ammo", label: "патроны пистолета", amount: 12, price: 15, maximum: 180}),
  Object.freeze({id: "automatic-ammo", label: "патроны автомата", amount: 30, price: 25, maximum: 240}),
  Object.freeze({id: "repair-plate", label: "ремонтная пластина", amount: 1, price: 30, maximum: 10, boatItem: true}),
  Object.freeze({id: "fuel-canister", label: "аварийная канистра", amount: 1, price: 25, maximum: 5, boatItem: true}),
]);

const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const clampIndex = value => ((Math.floor(Number(value) || 0) % SHOP_ITEMS.length) + SHOP_ITEMS.length) % SHOP_ITEMS.length;

export function deliveryCreditReward(crate) {
  if (crate?.rarity === "rare") return 50;
  if (crate?.rarity === "uncommon") return 30;
  return 20;
}

export function ensureShopState(world) {
  const activities = world.freeActivities;
  if (!activities) return null;
  if (!Number.isFinite(activities.credits)) activities.credits = 0;
  activities.shopOpen ||= Array.from({length: world.players?.length || 2}, () => false);
  activities.shopSelection ||= Array.from({length: world.players?.length || 2}, () => 0);
  activities.merchantPrompted ||= Array.from({length: world.players?.length || 2}, () => false);
  while (activities.shopOpen.length < world.players.length) activities.shopOpen.push(false);
  while (activities.shopSelection.length < world.players.length) activities.shopSelection.push(0);
  while (activities.merchantPrompted.length < world.players.length) activities.merchantPrompted.push(false);
  activities.shopSelection = activities.shopSelection.map(clampIndex);
  return activities;
}

export function merchantNavigationTarget() {
  return {...MERCHANT};
}

export function isPlayerNearMerchant(player, maximum = MERCHANT_ACTION_RANGE) {
  return Boolean(player?.mode === "foot" && distance(player, MERCHANT) <= maximum);
}

function ownedDockedBoat(world, playerIndex) {
  return (world.boats || []).find(boat => (
    boat.owner === playerIndex && !boat.sunk && isBoatDockPosition(boat)
  )) || null;
}

function itemCount(world, playerIndex, item) {
  const combat = world.players?.[playerIndex]?.combat;
  if (item.id === "pistol-ammo") return Number(combat?.pistolAmmo) || 0;
  if (item.id === "automatic-ammo") return Number(combat?.ammo) || 0;
  const boat = ownedDockedBoat(world, playerIndex);
  if (item.id === "repair-plate") return Number(boat?.repairPatches) || 0;
  if (item.id === "fuel-canister") return Number(boat?.refuelCanisters) || 0;
  return 0;
}

function itemText(world, playerIndex, item) {
  const state = ensureShopState(world);
  const count = itemCount(world, playerIndex, item);
  return `${item.label}. За покупку: ${item.amount}. Цена ${item.price} кредитов. У тебя ${count}. Баланс команды ${state.credits}.`;
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function grantDeliveryCredits(world, crate) {
  const state = ensureShopState(world);
  const reward = deliveryCreditReward(crate);
  state.credits += reward;
  return reward;
}

export function handleMerchantAction(world, playerIndex) {
  const state = ensureShopState(world);
  const player = world.players?.[playerIndex];
  if (!player?.combat?.alive || !isPlayerNearMerchant(player)) return false;
  state.shopOpen[playerIndex] = true;
  state.shopSelection[playerIndex] = clampIndex(state.shopSelection[playerIndex]);
  const item = SHOP_ITEMS[state.shopSelection[playerIndex]];
  emit(world, "shop-open", `Магазин открыт. ${itemText(world, playerIndex, item)} Листай товары и подтверждай покупку.`, [playerIndex], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    x: MERCHANT.x,
    y: MERCHANT.y,
  });
  return true;
}

function closeShop(world, playerIndex, text = "Магазин закрыт.") {
  const state = ensureShopState(world);
  if (!state.shopOpen[playerIndex]) return false;
  state.shopOpen[playerIndex] = false;
  emit(world, "shop-closed", text, [playerIndex], {sourcePlayer: playerIndex, x: MERCHANT.x, y: MERCHANT.y});
  return true;
}

function purchase(world, playerIndex) {
  const state = ensureShopState(world);
  const item = SHOP_ITEMS[state.shopSelection[playerIndex]];
  const player = world.players?.[playerIndex];
  const combat = player?.combat;
  if (!item || !combat) return;
  if (state.credits < item.price) {
    emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${item.price}, баланс команды ${state.credits}.`, [playerIndex]);
    return;
  }

  const boat = item.boatItem ? ownedDockedBoat(world, playerIndex) : null;
  if (item.boatItem && !boat) {
    emit(world, "shop-denied", "Собственная лодка должна стоять у причала, чтобы купить этот товар.", [playerIndex]);
    return;
  }

  const current = itemCount(world, playerIndex, item);
  if (current + item.amount > item.maximum) {
    emit(world, "shop-denied", `Покупка не помещается. Максимум: ${item.maximum}. Сейчас у тебя ${current}.`, [playerIndex]);
    return;
  }

  if (item.id === "pistol-ammo") combat.pistolAmmo += item.amount;
  else if (item.id === "automatic-ammo") combat.ammo += item.amount;
  else if (item.id === "repair-plate") boat.repairPatches += item.amount;
  else if (item.id === "fuel-canister") boat.refuelCanisters += item.amount;
  state.credits -= item.price;
  emit(world, "shop-purchased", `Куплено: ${item.label}, ${item.amount}. Баланс команды ${state.credits}.`, [0, 1], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    price: item.price,
    credits: state.credits,
    x: MERCHANT.x,
    y: MERCHANT.y,
  });
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

export function updateMerchantShop(world) {
  const state = ensureShopState(world);
  if (!state) return;
  const inputs = state.inputs || [];
  const previous = state.previousInputs || [];
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const near = Boolean(state.presence?.[index] && player?.combat?.alive && isPlayerNearMerchant(player));
    if (near && !state.merchantPrompted[index]) {
      state.merchantPrompted[index] = true;
      emit(world, "merchant-ready", "Торговец рядом. Действие — открыть магазин.", [index], {
        sourcePlayer: index,
        x: MERCHANT.x,
        y: MERCHANT.y,
      });
    } else if (!near && distance(player, MERCHANT) > MERCHANT_ACTION_RANGE + 3) {
      state.merchantPrompted[index] = false;
    }

    if (!state.shopOpen[index]) continue;
    if (!near) {
      closeShop(world, index, "Ты отошёл от торговца. Магазин закрыт.");
      continue;
    }
    if (rising(inputs[index], previous[index], "shopClose")) {
      closeShop(world, index);
      continue;
    }
    if (rising(inputs[index], previous[index], "shopPrevious") || rising(inputs[index], previous[index], "shopNext")) {
      const direction = rising(inputs[index], previous[index], "shopPrevious") ? -1 : 1;
      state.shopSelection[index] = clampIndex(state.shopSelection[index] + direction);
      const item = SHOP_ITEMS[state.shopSelection[index]];
      emit(world, "shop-selection", itemText(world, index, item), [index], {
        sourcePlayer: index,
        itemId: item.id,
        x: MERCHANT.x,
        y: MERCHANT.y,
      });
    }
    if (rising(inputs[index], previous[index], "shopBuy")) purchase(world, index);
  }
}

export function suppressGameplayWhileShopping(world) {
  const state = ensureShopState(world);
  if (!state) return;
  const blocked = ["up", "down", "left", "right", "run", "pump", "repair", "action", "jump", "attack", "weapon", "sonar", "guide"];
  for (let index = 0; index < world.players.length; index += 1) {
    if (!state.shopOpen[index]) continue;
    for (const source of [world.inputs?.[index], world.operationInputs?.[index], state.inputs?.[index]]) {
      if (!source) continue;
      for (const key of blocked) source[key] = false;
    }
  }
}
