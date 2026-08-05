import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTOMATIC_WEAPON_PRICE,
  MERCHANT,
  SHOP_ITEMS,
  handleMerchantAction,
  updateMerchantShop,
} from "../public/src/free-roam-shop-v8.js";

function makePlayer(automatic = false, ammo = 0) {
  return {
    mode: "foot",
    x: MERCHANT.x,
    y: MERCHANT.y,
    combat: {
      alive: true,
      weapons: {automatic},
      equipped: automatic ? "automatic" : "fists",
      ammo,
    },
  };
}

function makeWorld({credits = AUTOMATIC_WEAPON_PRICE, buyer = 1, automatic = false, ammo = 0} = {}) {
  const players = [makePlayer(true, 40), makePlayer(false, 0)];
  players[buyer] = makePlayer(automatic, ammo);
  const automaticIndex = SHOP_ITEMS.findIndex(item => item.id === "automatic-ammo");
  return {
    time: 12,
    players,
    boats: [],
    events: [],
    freeContracts: {scrap: 0},
    freeActivities: {
      credits,
      presence: [true, true],
      inputs: [{}, {}],
      previousInputs: [{}, {}],
      shopOpen: [false, false],
      shopSelection: [0, 0],
      merchantPrompted: [false, false],
      freeWreckRecoveryUsed: [false, false],
      automaticIndex,
    },
  };
}

function armPurchase(world, buyer) {
  const state = world.freeActivities;
  state.shopOpen[buyer] = true;
  state.shopSelection[buyer] = state.automaticIndex;
  state.inputs[buyer] = {shopBuy: true};
  state.previousInputs[buyer] = {shopBuy: false};
}

test("the automatic-ammo slot sells the missing player an automatic for 120 credits", () => {
  const world = makeWorld({buyer: 1, ammo: 47});
  armPurchase(world, 1);
  updateMerchantShop(world);

  assert.equal(world.players[1].combat.weapons.automatic, true);
  assert.equal(world.players[1].combat.equipped, "automatic");
  assert.equal(world.players[1].combat.ammo, 47);
  assert.equal(world.players[0].combat.ammo, 40);
  assert.equal(world.freeActivities.credits, 0);
  const purchase = world.events.find(event => event.itemId === "automatic-weapon");
  assert.equal(purchase?.type, "shop-purchased");
  assert.equal(purchase?.sourcePlayer, 1);
});

test("the shop does not sell ammunition before the buyer owns the automatic", () => {
  const world = makeWorld({credits: AUTOMATIC_WEAPON_PRICE - 1, buyer: 0, automatic: false});
  armPurchase(world, 0);
  updateMerchantShop(world);

  assert.equal(world.players[0].combat.weapons.automatic, false);
  assert.equal(world.players[0].combat.ammo, 0);
  assert.equal(world.freeActivities.credits, AUTOMATIC_WEAPON_PRICE - 1);
  const denied = world.events.find(event => event.itemId === "automatic-weapon");
  assert.equal(denied?.type, "shop-denied");
});

test("after the weapon purchase the same slot returns to ordinary ammunition", () => {
  const world = makeWorld({credits: 25, buyer: 1, automatic: true, ammo: 10});
  armPurchase(world, 1);
  updateMerchantShop(world);

  assert.equal(world.players[1].combat.ammo, 40);
  assert.equal(world.freeActivities.credits, 0);
  assert.equal(world.events.at(-1).itemId, "automatic-ammo");
});

test("opening the selected slot announces the automatic when the player lacks it", () => {
  const world = makeWorld({buyer: 1});
  world.freeActivities.shopSelection[1] = world.freeActivities.automaticIndex;
  assert.equal(handleMerchantAction(world, 1), true);
  assert.match(world.events.at(-1).text, /Автомат\. Цена 120 кредитов/);
});
