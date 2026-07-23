import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";
import {
  MERCHANT,
  SHOP_ITEMS,
  deliveryCreditReward,
} from "../public/src/free-roam-shop.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";

function pulse(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {});
  stepFreeWorld(world, 0.05);
}

function putPlayerAtMerchant(world, playerIndex = 0) {
  const player = world.players[playerIndex];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = MERCHANT.x;
  player.y = MERCHANT.y;
  player.combat.alive = true;
  const boat = world.boats.find(candidate => candidate.owner === playerIndex);
  boat.x = 210;
  boat.y = 90;
  boat.speed = 0;
  boat.sunk = false;
  return {player, boat};
}

function openShop(world, playerIndex = 0) {
  putPlayerAtMerchant(world, playerIndex);
  drainEvents(world);
  pulse(world, playerIndex, {action: true});
  assert.equal(world.freeActivities.shopOpen[playerIndex], true);
}

function selectItem(world, playerIndex, itemId) {
  const target = SHOP_ITEMS.findIndex(item => item.id === itemId);
  assert.ok(target >= 0);
  while (world.freeActivities.shopSelection[playerIndex] !== target) {
    pulse(world, playerIndex, {shopNext: true});
  }
}

test("delivery credit values follow cargo rarity", () => {
  assert.equal(deliveryCreditReward({rarity: "common"}), 20);
  assert.equal(deliveryCreditReward({rarity: "uncommon"}), 30);
  assert.equal(deliveryCreditReward({rarity: "rare"}), 50);
});

test("an existing boat delivery awards shared credits exactly once", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.rarity === "common");
  boat.x = 210;
  boat.y = 90;
  boat.speed = 0;
  crate.state = "stowed";
  crate.stowedBoat = boat.id;
  boat.cargo = [crate.id];

  for (let index = 0; index < 12; index += 1) stepFreeWorld(world, 0.05);
  assert.equal(world.freeActivities.credits, 20);
  assert.equal(world.freeActivities.delivered[0], 1);

  for (let index = 0; index < 12; index += 1) stepFreeWorld(world, 0.05);
  assert.equal(world.freeActivities.credits, 20, "the same unloaded crate must not pay twice");
});

test("the merchant only opens on foot inside the action range", () => {
  const world = createFreeWorld();
  world.players[0].mode = "foot";
  world.players[0].activeBoat = null;
  world.players[0].x = MERCHANT.x + 30;
  world.players[0].y = MERCHANT.y;
  pulse(world, 0, {action: true});
  assert.equal(world.freeActivities.shopOpen[0], false);

  putPlayerAtMerchant(world, 0);
  pulse(world, 0, {action: true});
  assert.equal(world.freeActivities.shopOpen[0], true);
  assert.ok(drainEvents(world).some(event => event.type === "shop-open"));
});

test("one purchase pulse buys one pistol ammunition pack", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 40;
  const before = world.players[0].combat.pistolAmmo;
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.pistolAmmo, before + 12);
  assert.equal(world.freeActivities.credits, 25);
  assert.equal(drainEvents(world).filter(event => event.type === "shop-purchased").length, 1);
});

test("a held shop input is edge-triggered instead of buying every frame", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 100;
  const before = world.players[0].combat.pistolAmmo;
  setPlayerInput(world, 0, {shopBuy: true});
  for (let index = 0; index < 8; index += 1) stepFreeWorld(world, 0.05);
  assert.equal(world.players[0].combat.pistolAmmo, before + 12);
  assert.equal(world.freeActivities.credits, 85);
});

test("insufficient credits never change inventory", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 14;
  const before = world.players[0].combat.pistolAmmo;
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.pistolAmmo, before);
  assert.equal(world.freeActivities.credits, 14);
  assert.ok(drainEvents(world).some(event => event.type === "shop-denied"));
});

test("automatic ammunition can be purchased before the automatic is found", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 80;
  selectItem(world, 0, "automatic-ammo");
  assert.equal(world.players[0].combat.weapons.automatic, false);
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.ammo, 30);
  assert.equal(world.freeActivities.credits, 55);
});

test("boat supplies require the player's own boat at the dock", () => {
  const world = createFreeWorld();
  const {boat} = putPlayerAtMerchant(world, 0);
  pulse(world, 0, {action: true});
  world.freeActivities.credits = 100;
  selectItem(world, 0, "repair-plate");
  boat.x = 20;
  boat.y = 200;
  const before = boat.repairPatches;
  pulse(world, 0, {shopBuy: true});
  assert.equal(boat.repairPatches, before);
  assert.equal(world.freeActivities.credits, 100);

  boat.x = 210;
  boat.y = 90;
  pulse(world, 0, {shopBuy: true});
  assert.equal(boat.repairPatches, before + 1);
  assert.equal(world.freeActivities.credits, 70);
});

test("shopping suppresses movement and combat commands on the server", () => {
  const world = createFreeWorld();
  const {player} = putPlayerAtMerchant(world, 0);
  pulse(world, 0, {action: true});
  const before = {x: player.x, y: player.y, ammo: player.combat.pistolAmmo};
  setPlayerInput(world, 0, {up: true, attack: true, shopBuy: false});
  stepFreeWorld(world, 0.1);
  assert.equal(player.x, before.x);
  assert.equal(player.y, before.y);
  assert.equal(player.combat.pistolAmmo, before.ammo);
});

test("selecting merchant navigation makes sonar target the trading dock", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {navigationTargetId: "merchant"});
  stepFreeWorld(world, 0.05);
  const target = scenarioTarget(world, 0);
  assert.equal(target.kind, "merchant");
  assert.equal(target.id, MERCHANT.id);
});

test("active pursuit keeps combat sonar priority over merchant navigation", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "pursuit";
  world.freeActivities.marauder.active = true;
  world.freeActivities.marauder.destroyed = false;
  setPlayerInput(world, 0, {navigationTargetId: "merchant"});
  stepFreeWorld(world, 0.05);
  assert.notEqual(scenarioTarget(world, 0)?.kind, "merchant");
});

test("credits and shop state are included in replicated server snapshots", () => {
  const world = createFreeWorld();
  openShop(world);
  world.freeActivities.credits = 75;
  world.freeScenario.navigationModes[0] = "merchant";
  const replicated = replicatedFreeWorld(world);
  assert.equal(replicated.freeActivities.credits, 75);
  assert.equal(replicated.freeActivities.shopOpen[0], true);
  assert.equal(replicated.freeScenario.navigationModes[0], "merchant");
});

test("shop capacity limits reject oversized purchases without spending credits", () => {
  const world = createFreeWorld();
  const {boat} = putPlayerAtMerchant(world, 0);
  pulse(world, 0, {action: true});
  world.freeActivities.credits = 200;

  world.players[0].combat.pistolAmmo = 175;
  pulse(world, 0, {shopBuy: true});
  assert.equal(world.players[0].combat.pistolAmmo, 175);
  assert.equal(world.freeActivities.credits, 200);

  selectItem(world, 0, "fuel-canister");
  boat.refuelCanisters = 4;
  pulse(world, 0, {shopBuy: true});
  assert.equal(boat.refuelCanisters, 5);
  assert.equal(world.freeActivities.credits, 175);
  pulse(world, 0, {shopBuy: true});
  assert.equal(boat.refuelCanisters, 5);
  assert.equal(world.freeActivities.credits, 175);
});

test("a crate directly underfoot remains collectible beside the merchant", () => {
  const world = createFreeWorld();
  const {player} = putPlayerAtMerchant(world, 0);
  const crate = world.freeActivities.crates[0];
  crate.state = "world";
  crate.x = player.x;
  crate.y = player.y;
  pulse(world, 0, {action: true});
  assert.equal(player.combat.carriedCrate, crate.id);
  assert.equal(world.freeActivities.shopOpen[0], false);
});
