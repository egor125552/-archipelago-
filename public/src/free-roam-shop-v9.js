"use strict";

import * as base from "./free-roam-shop-v8.js?v=1";
import {isBoatDockPosition} from "./free-roam-cargo-rules.js?v=32";
import {ensureContracts} from "./free-roam-contracts.js?v=3";

export * from "./free-roam-shop-v8.js?v=1";

export const SHOP_ITEMS = base.SHOP_ITEMS;
export const UPGRADE_CREDIT_MULTIPLIER = 20;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function ownedDockedBoat(world, playerIndex) {
  return (world.boats || []).find(boat => (
    boat?.owner === playerIndex
    && !boat.sunk
    && isBoatDockPosition(boat)
  )) || null;
}

export function upgradeCreditPrice(item, nextLevel) {
  const scrapPrice = Math.max(0, Number(item?.scrapPrice) || 0);
  const level = Math.max(1, Math.floor(Number(nextLevel) || 1));
  const scaled = scrapPrice * UPGRADE_CREDIT_MULTIPLIER * (1 + (level - 1) * 0.5);
  return Math.max(10, Math.round(scaled / 10) * 10);
}

function applyUpgrade(boat, item, level) {
  boat[item.upgrade] = level;
  if (item.id === "hull-upgrade") {
    boat.collisionDamageMultiplier = clamp(1 - level * 0.14, 0.55, 1);
    boat.armorMax = Math.max(Number(boat.armorMax) || 0, level * 18);
    boat.armor = boat.armorMax;
    boat.repairPatches = Math.min(10, (Number(boat.repairPatches) || 0) + 1);
    return `Урон от столкновений снижен, броня восстановлена до ${Math.round(boat.armorMax)}.`;
  }
  if (item.id === "pump-upgrade") {
    boat.cargoPumpBonus = Math.max(Number(boat.cargoPumpBonus) || 0, level * 2.5);
    return `Дополнительная откачка теперь ${boat.cargoPumpBonus.toFixed(1)} процента воды в секунду.`;
  }
  if (item.id === "engine-upgrade") {
    return `Максимальный ход и разгон увеличены примерно на ${level * 12} процентов.`;
  }
  boat.collisionLeakMultiplier = clamp(1 - level * 0.14, 0.55, 1);
  return "При новых повреждениях вода поступает медленнее.";
}

function upgradeDescription(world, playerIndex, item) {
  const state = base.ensureShopState(world);
  const contracts = ensureContracts(world);
  const boat = ownedDockedBoat(world, playerIndex);
  const current = Math.max(0, Math.floor(Number(boat?.[item.upgrade]) || 0));
  if (current >= item.maximum) {
    return `${item.label}. Постоянный уровень ${current} из ${item.maximum}. Улучшение уже максимального уровня.`;
  }
  const nextLevel = current + 1;
  const creditPrice = upgradeCreditPrice(item, nextLevel);
  return `${item.label}. Следующий постоянный уровень ${nextLevel} из ${item.maximum}. Цена ${item.scrapPrice} металлолома или ${creditPrice} кредитов. Сначала используется металлолом; если его не хватает — кредиты. Металлолом команды ${contracts.scrap}. Баланс команды ${state?.credits || 0}.`;
}

function fuelCanisterDescription(world, playerIndex) {
  const state = base.ensureShopState(world);
  const boat = ownedDockedBoat(world, playerIndex);
  const count = Math.max(0, Math.floor(Number(boat?.refuelCanisters) || 0));
  const item = SHOP_ITEMS.find(candidate => candidate.id === "fuel-canister");
  return `Аварийная канистра. Каждая канистра после завершения заправки заполняет бак до 100 процентов. За покупку: ${item?.amount || 1}. Цена ${item?.price || 25} кредитов. У тебя ${count}. Максимум ${item?.maximum || 5}. Баланс команды ${state?.credits || 0}.`;
}

export function patchUpgradeShopEvents(world, startIndex = 0) {
  const events = world.events || [];
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event || !["shop-open", "shop-selection"].includes(event.type)) continue;
    const item = SHOP_ITEMS.find(candidate => candidate.id === event.itemId);
    if (!item) continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : Math.max(0, Number(event.targets?.[0]) || 0);
    let text = null;
    if (item.upgrade) text = upgradeDescription(world, playerIndex, item);
    else if (item.id === "fuel-canister") text = fuelCanisterDescription(world, playerIndex);
    if (!text) continue;
    event.text = event.type === "shop-open"
      ? `Магазин открыт. ${text} Листай товары, сервис и постоянные улучшения.`
      : text;
  }
}

function tryCreditUpgradePurchase(world, playerIndex) {
  const state = base.ensureShopState(world);
  if (!state?.shopOpen?.[playerIndex]) return false;
  const input = state.inputs?.[playerIndex];
  const previous = state.previousInputs?.[playerIndex];
  if (!rising(input, previous, "shopBuy")) return false;

  const item = SHOP_ITEMS[state.shopSelection?.[playerIndex] || 0];
  if (!item?.upgrade) return false;
  const boat = ownedDockedBoat(world, playerIndex);
  if (!boat) return false;

  const current = Math.max(0, Math.floor(Number(boat[item.upgrade]) || 0));
  if (current >= item.maximum) return false;

  const contracts = ensureContracts(world);
  if (contracts.scrap >= item.scrapPrice) return false;

  const nextLevel = current + 1;
  const creditPrice = upgradeCreditPrice(item, nextLevel);
  if (state.credits < creditPrice) {
    emit(world, "shop-denied", `Недостаточно ресурсов для ${item.label}. Нужно ${item.scrapPrice} металлолома или ${creditPrice} кредитов. У команды ${contracts.scrap} металлолома и ${state.credits} кредитов.`, [playerIndex], {
      sourcePlayer: playerIndex,
      itemId: item.id,
      scrapPrice: item.scrapPrice,
      price: creditPrice,
    });
    return true;
  }

  state.credits -= creditPrice;
  const detail = applyUpgrade(boat, item, nextLevel);
  emit(world, "shop-upgrade-purchased", `Установлено за кредиты: ${item.label}, уровень ${nextLevel} из ${item.maximum}. ${detail} Баланс команды ${state.credits}. Металлолом не израсходован.`, [0, 1], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    currency: "credits",
    price: creditPrice,
    credits: state.credits,
    scrap: contracts.scrap,
    level: nextLevel,
    x: base.MERCHANT.x,
    y: base.MERCHANT.y,
  });
  return true;
}

export function handleMerchantAction(world, playerIndex) {
  const startIndex = world.events?.length || 0;
  const opened = base.handleMerchantAction(world, playerIndex);
  patchUpgradeShopEvents(world, startIndex);
  return opened;
}

export function updateMerchantShop(world) {
  const state = base.ensureShopState(world);
  if (!state) return base.updateMerchantShop(world);
  const startIndex = world.events?.length || 0;
  const suppressed = [];

  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (!tryCreditUpgradePurchase(world, index)) continue;
    const input = state.inputs?.[index];
    if (!input) continue;
    suppressed.push([input, input.shopBuy]);
    input.shopBuy = false;
  }

  base.updateMerchantShop(world);
  for (const [input, value] of suppressed) input.shopBuy = value;
  patchUpgradeShopEvents(world, startIndex);
}
