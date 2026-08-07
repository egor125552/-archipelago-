import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v7.js";
import {ensureContracts} from "../public/src/free-roam-contracts.js";
import {
  MERCHANT,
  SHOP_ITEMS,
  upgradeCreditPrice,
} from "../public/src/free-roam-shop-v9.js";

function pulse(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {});
  stepFreeWorld(world, 0.05);
}

function openShop(world, playerIndex = 0) {
  const player = world.players[playerIndex];
  const boat = world.boats.find(candidate => candidate.owner === playerIndex);
  player.mode = "foot";
  player.activeBoat = null;
  player.x = MERCHANT.x;
  player.y = MERCHANT.y;
  player.combat.alive = true;
  boat.x = 210;
  boat.y = 90;
  boat.speed = 0;
  boat.sunk = false;
  drainEvents(world);
  pulse(world, playerIndex, {action: true});
  assert.equal(world.freeActivities.shopOpen[playerIndex], true);
  return boat;
}

function selectItem(world, playerIndex, itemId) {
  const target = SHOP_ITEMS.findIndex(item => item.id === itemId);
  assert.ok(target >= 0, `missing shop item ${itemId}`);
  while (world.freeActivities.shopSelection[playerIndex] !== target) {
    pulse(world, playerIndex, {shopNext: true});
  }
}

const upgrades = [
  ["hull-upgrade", "hullUpgradeLevel"],
  ["pump-upgrade", "pumpUpgradeLevel"],
  ["engine-upgrade", "engineUpgradeLevel"],
  ["seal-upgrade", "sealUpgradeLevel"],
];

for (const [itemId, property] of upgrades) {
  test(`${itemId} can be purchased with credits when scrap is insufficient`, () => {
    const world = createFreeWorld();
    const boat = openShop(world);
    const contracts = ensureContracts(world);
    const item = SHOP_ITEMS.find(candidate => candidate.id === itemId);
    const price = upgradeCreditPrice(item, 1);
    contracts.scrap = 0;
    world.freeActivities.credits = price;
    selectItem(world, 0, itemId);
    drainEvents(world);

    pulse(world, 0, {shopBuy: true});

    assert.equal(boat[property], 1);
    assert.equal(world.freeActivities.credits, 0);
    assert.equal(contracts.scrap, 0);
    const event = drainEvents(world).find(candidate => candidate.type === "shop-upgrade-purchased");
    assert.equal(event?.itemId, itemId);
    assert.equal(event?.currency, "credits");
    assert.equal(event?.price, price);
  });
}

test("scrap remains the preferred payment when enough scrap is available", () => {
  const world = createFreeWorld();
  const boat = openShop(world);
  const contracts = ensureContracts(world);
  const item = SHOP_ITEMS.find(candidate => candidate.id === "hull-upgrade");
  contracts.scrap = item.scrapPrice;
  world.freeActivities.credits = 999;
  selectItem(world, 0, item.id);
  drainEvents(world);

  pulse(world, 0, {shopBuy: true});

  assert.equal(boat.hullUpgradeLevel, 1);
  assert.equal(contracts.scrap, 0);
  assert.equal(world.freeActivities.credits, 999);
  const event = drainEvents(world).find(candidate => candidate.type === "shop-upgrade-purchased");
  assert.equal(event?.price, item.scrapPrice);
  assert.equal(event?.currency, "scrap");
});

test("credit prices rise with each permanent upgrade level", () => {
  const world = createFreeWorld();
  const boat = openShop(world);
  const contracts = ensureContracts(world);
  const item = SHOP_ITEMS.find(candidate => candidate.id === "engine-upgrade");
  contracts.scrap = 0;
  selectItem(world, 0, item.id);

  const firstPrice = upgradeCreditPrice(item, 1);
  const secondPrice = upgradeCreditPrice(item, 2);
  assert.equal(firstPrice, 200);
  assert.equal(secondPrice, 300);

  world.freeActivities.credits = firstPrice + secondPrice;
  pulse(world, 0, {shopBuy: true});
  pulse(world, 0, {shopBuy: true});

  assert.equal(boat.engineUpgradeLevel, 2);
  assert.equal(world.freeActivities.credits, 0);
});

test("shop descriptions announce both upgrade currencies and canister inventory limits", () => {
  const world = createFreeWorld();
  openShop(world);
  ensureContracts(world).scrap = 3;
  world.freeActivities.credits = 500;

  selectItem(world, 0, "hull-upgrade");
  let event = drainEvents(world).find(candidate => (
    candidate.type === "shop-selection" && candidate.itemId === "hull-upgrade"
  ));
  assert.match(event?.text || "", /8 металлолома или 160 кредитов/);

  selectItem(world, 0, "fuel-canister");
  event = drainEvents(world).find(candidate => (
    candidate.type === "shop-selection" && candidate.itemId === "fuel-canister"
  ));
  assert.match(event?.text || "", /аварийная канистра/i);
  assert.match(event?.text || "", /Максимум 5/);
});
