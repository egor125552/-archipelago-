"use strict";

import * as base from "./free-roam-shop-v9.js?v=1";
import {isBoatDockPosition} from "./free-roam-cargo-rules.js?v=32";
import {ensureContracts} from "./free-roam-contracts.js?v=3";

export * from "./free-roam-shop-v9.js?v=1";
export const SHOP_ITEMS = base.SHOP_ITEMS;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function candidateBoatIds(world, playerIndex) {
  const player = world.players?.[playerIndex];
  const preferred = [player?.activeBoat, player?.lastBoatId].filter(Number.isInteger);
  const associated = (world.boats || []).filter(boat => boat && (
    boat.owner === playerIndex
    || boat.driver === playerIndex
    || (Array.isArray(boat.crew) && boat.crew.includes(playerIndex))
  )).map(boat => boat.id);
  return [...new Set([...preferred, ...associated])];
}

export function merchantBoatForPlayer(world, playerIndex, {docked = false, sunk = null} = {}) {
  for (const boatId of candidateBoatIds(world, playerIndex)) {
    const boat = world.boats?.[boatId];
    if (!boat || boat.shopEligible === false) continue;
    if (sunk === true && !boat.sunk) continue;
    if (sunk === false && boat.sunk) continue;
    if (docked && (!isBoatDockPosition(boat) || boat.sunk)) continue;
    return boat;
  }
  return null;
}

function maximumHull(boat) {
  return Math.max(1, Number(boat?.hullMax) || 100);
}

function maximumArmor(boat) {
  return Math.max(0, Number(boat?.armorMax) || 0);
}

function itemCount(boat, item) {
  if (!boat) return 0;
  if (item.id === "repair-plate") return Math.max(0, Math.floor(Number(boat.repairPatches) || 0));
  if (item.id === "fuel-canister") return Math.max(0, Math.floor(Number(boat.refuelCanisters) || 0));
  if (item.upgrade) return Math.max(0, Math.floor(Number(boat[item.upgrade]) || 0));
  return 0;
}

function applyUpgrade(boat, item, level) {
  boat[item.upgrade] = level;
  if (item.id === "hull-upgrade") {
    boat.collisionDamageMultiplier = clamp(1 - level * 0.14, 0.55, 1);
    boat.armorMax = Math.max(maximumArmor(boat), level * 18);
    boat.armor = boat.armorMax;
    boat.repairPatches = Math.min(10, itemCount(boat, {id: "repair-plate"}) + 1);
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

function boatItemDescription(world, playerIndex, item) {
  const state = base.ensureShopState(world);
  const contracts = ensureContracts(world);
  const boat = item.wreckService
    ? merchantBoatForPlayer(world, playerIndex, {sunk: true})
    : merchantBoatForPlayer(world, playerIndex, {docked: true, sunk: false});
  const label = boat?.label || "лодка";

  if (item.wreckService) {
    return `${item.label}. Цена ${item.price} кредитов. ${boat ? `${label} затонул и доступен для подъёма.` : "Связанная с тобой лодка не затонула."} Баланс команды ${state?.credits || 0}.`;
  }
  if (item.service) {
    const condition = boat
      ? `${label}: корпус ${Math.round(Number(boat.hull) || 0)} из ${Math.round(maximumHull(boat))}, броня ${Math.round(Number(boat.armor) || 0)} из ${Math.round(maximumArmor(boat))}, вода ${Math.round(Number(boat.water) || 0)} процентов.`
      : "Последняя использованная лодка не стоит у причала.";
    return `${item.label}. Цена ${item.price} кредитов. ${condition} Баланс команды ${state?.credits || 0}.`;
  }
  if (item.upgrade) {
    const current = itemCount(boat, item);
    if (current >= item.maximum) return `${item.label}. Уровень ${current} из ${item.maximum}. Улучшение максимального уровня.`;
    const nextLevel = current + 1;
    const creditPrice = base.upgradeCreditPrice(item, nextLevel);
    return `${item.label}. Для ${label}. Следующий уровень ${nextLevel} из ${item.maximum}. Цена ${item.scrapPrice} металлолома или ${creditPrice} кредитов. Металлолом команды ${contracts.scrap}. Баланс команды ${state?.credits || 0}.`;
  }
  return `${item.label}. Для ${label}. За покупку: ${item.amount}. Цена ${item.price} кредитов. Сейчас ${itemCount(boat, item)}. Максимум ${item.maximum}. Баланс команды ${state?.credits || 0}.`;
}

function patchBoatShopEvents(world, startIndex = 0) {
  for (const event of (world.events || []).slice(startIndex)) {
    if (!event || !["shop-open", "shop-selection"].includes(event.type)) continue;
    const item = SHOP_ITEMS.find(candidate => candidate.id === event.itemId);
    if (!item || (!item.boatItem && !item.wreckService)) continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : Math.max(0, Number(event.targets?.[0]) || 0);
    const text = boatItemDescription(world, playerIndex, item);
    event.text = event.type === "shop-open"
      ? `Магазин открыт. ${text} Листай товары, сервис и постоянные улучшения.`
      : text;
  }
}

function recoverWreck(world, playerIndex, boat, item, state) {
  if (!boat?.sunk) {
    emit(world, "shop-denied", "Связанная с тобой лодка не затонула. Подъём не требуется.", [playerIndex]);
    return;
  }
  if (state.credits < item.price) {
    emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${item.price}, баланс команды ${state.credits}.`, [playerIndex]);
    return;
  }
  state.credits -= item.price;
  const hullMax = maximumHull(boat);
  boat.sunk = false;
  boat.x = Number.isFinite(Number(boat.homeX)) ? Number(boat.homeX) : (playerIndex === 0 ? 174 : 246);
  boat.y = Number.isFinite(Number(boat.homeY)) ? Number(boat.homeY) : 90;
  boat.heading = Number(boat.homeHeading) || 0;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;
  boat.driver = null;
  if (Array.isArray(boat.crew)) boat.crew.fill(null);
  boat.hull = Math.max(1, hullMax * 0.2);
  boat.armor = 0;
  boat.water = 35;
  boat.leak = clamp(Number(boat.leak) || 0.8, 0.8, 2.5);
  boat.engineTemp = Math.min(Number(boat.engineTemp) || 55, 65);
  boat.engineStalled = true;
  boat.emergencyActive = false;
  boat.emergencyRemaining = 0;
  boat.restartProgress = 0;
  boat.fuel = Math.max(10, Number(boat.fuel) || 0);
  emit(world, "wreck-recovery-complete", `Подъём завершён. ${boat.label || "Лодка"} находится у причала: корпус ${Math.round(boat.hull)} из ${Math.round(hullMax)}, вода 35, двигатель заглушён. Баланс команды ${state.credits}.`, [0, 1], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    boatId: boat.id,
    price: item.price,
    credits: state.credits,
    x: boat.x,
    y: boat.y,
  });
}

function serviceBoat(world, playerIndex, boat, item, state) {
  const hullMax = maximumHull(boat);
  const armorMax = maximumArmor(boat);
  const alreadyHealthy = Number(boat.hull) >= hullMax - 0.5
    && Number(boat.armor || 0) >= armorMax - 0.5
    && Number(boat.water || 0) <= 0.5
    && Number(boat.leak || 0) <= 0.05
    && Number(boat.engineTemp || 0) < 80;
  if (alreadyHealthy) {
    emit(world, "shop-denied", `${boat.label || "Лодка"}: полное восстановление не требуется. Кредиты не списаны.`, [playerIndex]);
    return;
  }
  if (state.credits < item.price) {
    emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${item.price}, баланс команды ${state.credits}.`, [playerIndex]);
    return;
  }
  state.credits -= item.price;
  boat.hull = hullMax;
  boat.armor = armorMax;
  boat.water = 0;
  boat.leak = 0;
  boat.engineTemp = Math.min(Number(boat.engineTemp) || 45, 55);
  boat.emergencyActive = false;
  boat.emergencyRemaining = 0;
  boat.restartProgress = 0;
  if (boat.fuel > 0.01) boat.engineStalled = false;
  emit(world, "shop-service-complete", `Полное восстановление завершено: ${boat.label || "лодка"}. Корпус ${Math.round(hullMax)} из ${Math.round(hullMax)}, броня ${Math.round(armorMax)} из ${Math.round(armorMax)}, вода 0. Баланс команды ${state.credits}.`, [0, 1], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    boatId: boat.id,
    price: item.price,
    credits: state.credits,
    x: base.MERCHANT.x,
    y: base.MERCHANT.y,
  });
}

function purchaseBoatItem(world, playerIndex, item) {
  const state = base.ensureShopState(world);
  const contracts = ensureContracts(world);
  if (!state) return true;

  if (item.wreckService) {
    const wreck = merchantBoatForPlayer(world, playerIndex, {sunk: true});
    if (!wreck) emit(world, "shop-denied", "Связанная с тобой лодка не затонула. Подъём не требуется.", [playerIndex]);
    else recoverWreck(world, playerIndex, wreck, item, state);
    return true;
  }

  const boat = merchantBoatForPlayer(world, playerIndex, {docked: true, sunk: false});
  if (!boat) {
    emit(world, "shop-denied", "Последняя использованная лодка должна стоять у причала, чтобы купить сервис или улучшение.", [playerIndex]);
    return true;
  }
  if (item.service) {
    serviceBoat(world, playerIndex, boat, item, state);
    return true;
  }
  if (item.upgrade) {
    const current = itemCount(boat, item);
    if (current >= item.maximum) {
      emit(world, "shop-denied", `${item.label} уже максимального уровня ${item.maximum}.`, [playerIndex]);
      return true;
    }
    const level = current + 1;
    const creditPrice = base.upgradeCreditPrice(item, level);
    let currency = "scrap";
    let price = item.scrapPrice;
    if (contracts.scrap >= item.scrapPrice) contracts.scrap -= item.scrapPrice;
    else if (state.credits >= creditPrice) {
      state.credits -= creditPrice;
      currency = "credits";
      price = creditPrice;
    } else {
      emit(world, "shop-denied", `Недостаточно ресурсов для ${item.label}. Нужно ${item.scrapPrice} металлолома или ${creditPrice} кредитов.`, [playerIndex]);
      return true;
    }
    const detail = applyUpgrade(boat, item, level);
    emit(world, "shop-upgrade-purchased", `Для ${boat.label || "лодки"} установлено: ${item.label}, уровень ${level} из ${item.maximum}. ${detail}`, [0, 1], {
      sourcePlayer: playerIndex,
      itemId: item.id,
      boatId: boat.id,
      currency,
      price,
      credits: state.credits,
      scrap: contracts.scrap,
      level,
      x: base.MERCHANT.x,
      y: base.MERCHANT.y,
    });
    return true;
  }

  const current = itemCount(boat, item);
  if (current + item.amount > item.maximum) {
    emit(world, "shop-denied", `Покупка не помещается. Максимум ${item.maximum}, сейчас ${current}.`, [playerIndex]);
    return true;
  }
  if (state.credits < item.price) {
    emit(world, "shop-denied", `Недостаточно кредитов. Нужно ${item.price}, баланс команды ${state.credits}.`, [playerIndex]);
    return true;
  }
  if (item.id === "repair-plate") boat.repairPatches = current + item.amount;
  else if (item.id === "fuel-canister") boat.refuelCanisters = current + item.amount;
  else return false;
  state.credits -= item.price;
  emit(world, "shop-purchased", `Для ${boat.label || "лодки"} куплено: ${item.label}, ${item.amount}. Теперь ${itemCount(boat, item)}. Баланс команды ${state.credits}.`, [0, 1], {
    sourcePlayer: playerIndex,
    itemId: item.id,
    boatId: boat.id,
    price: item.price,
    credits: state.credits,
    x: base.MERCHANT.x,
    y: base.MERCHANT.y,
  });
  return true;
}

export function handleMerchantAction(world, playerIndex) {
  const startIndex = world.events?.length || 0;
  const opened = base.handleMerchantAction(world, playerIndex);
  patchBoatShopEvents(world, startIndex);
  return opened;
}

export function updateMerchantShop(world) {
  const state = base.ensureShopState(world);
  if (!state) return base.updateMerchantShop(world);
  const startIndex = world.events?.length || 0;
  const suppressed = [];

  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (!state.shopOpen?.[index]) continue;
    const input = state.inputs?.[index];
    const previous = state.previousInputs?.[index];
    const item = SHOP_ITEMS[state.shopSelection?.[index] || 0];
    if (!item || (!item.boatItem && !item.wreckService) || !rising(input, previous, "shopBuy")) continue;
    purchaseBoatItem(world, index, item);
    if (input) {
      suppressed.push([input, input.shopBuy]);
      input.shopBuy = false;
    }
  }

  base.updateMerchantShop(world);
  for (const [input, value] of suppressed) input.shopBuy = value;
  patchBoatShopEvents(world, startIndex);
}
