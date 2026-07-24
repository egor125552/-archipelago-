import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {CONTRACT_BOARD} from "../public/src/free-roam-contracts.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";
import {MERCHANT, SHOP_ITEMS} from "../public/src/free-roam-shop.js";
import {createTargetMenu} from "../public/src/free-roam-target-menu.js";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js";
import {startHeavyPursuer, updateHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function tap(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  run(world, 0.08);
  setPlayerInput(world, playerIndex, {});
  run(world, 0.08);
}

function acceptSalvage(world) {
  world.freeScenario.phase = "victory";
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = CONTRACT_BOARD.x;
  player.y = CONTRACT_BOARD.y;
  tap(world, 0, {action: true});
  world.freeContracts.boardSelection[0] = world.freeContracts.offers.findIndex(offer => offer.category === "salvage");
  tap(world, 0, {boardAccept: true});
  return world.freeActivities.crates.find(crate => crate.id === world.freeContracts.activeContract.crateId);
}

test("iPhone-style action exits a stopped boat beside salvage without stowing it", () => {
  const world = createFreeWorld();
  const crate = acceptSalvage(world);
  const player = world.players[0];
  const boat = world.boats[0];
  player.mode = "boat";
  player.activeBoat = boat.id;
  boat.driver = 0;
  player.x = crate.x;
  player.y = crate.y;
  boat.x = crate.x;
  boat.y = crate.y;

  tap(world, 0, {action: true});

  assert.equal(crate.state, "world");
  assert.equal(crate.extracted, false);
  assert.equal(boat.cargo.includes(crate.id), false);
  assert.equal(player.mode, "swim");
  assert.equal(player.activeBoat, null);
  assert.ok(world.events.some(event => event.type === "exit"));
});

test("one accessible action starts timed crowbar work and pickup stays separate", () => {
  const world = createFreeWorld();
  const crate = acceptSalvage(world);
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = crate.x;
  player.y = crate.y;

  tap(world, 0, {action: true});
  assert.equal(crate.state, "world");
  assert.equal(crate.extracted, false);
  assert.ok(world.freeSalvageWork.workers[0]);

  run(world, Number(crate.extractionSeconds) + 0.7);
  assert.equal(crate.extracted, true);
  assert.equal(crate.state, "world");
  assert.equal(player.combat.carriedCrate, null);

  tap(world, 0, {action: true});
  assert.equal(crate.state, "carried");
  assert.equal(player.combat.carriedCrate, crate.id);
});

test("board navigation survives activity input normalization", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerInput(world, 0, {navigationTargetId: "board"});
  run(world, 0.1);
  const target = scenarioTarget(world, 0);
  assert.equal(world.freeScenario.navigationModes[0], "board");
  assert.equal(target?.id, "contract-board");
});

test("merchant can fully restore a docked boat and install scrap upgrades", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = MERCHANT.x;
  player.y = MERCHANT.y;
  boat.x = 210;
  boat.y = 82;
  boat.speed = 0;
  boat.hull = 34;
  boat.water = 61;
  boat.leak = 4;
  world.freeActivities.credits = 200;
  world.freeContracts.scrap = 30;

  tap(world, 0, {action: true});
  world.freeActivities.shopSelection[0] = SHOP_ITEMS.findIndex(item => item.id === "dock-service");
  tap(world, 0, {shopBuy: true});
  assert.equal(boat.hull, 100);
  assert.equal(boat.water, 0);
  assert.equal(boat.leak, 0);

  world.freeActivities.shopSelection[0] = SHOP_ITEMS.findIndex(item => item.id === "hull-upgrade");
  tap(world, 0, {shopBuy: true});
  assert.equal(boat.hullUpgradeLevel, 1);
  assert.ok(boat.collisionDamageMultiplier < 1);
  assert.equal(world.freeContracts.scrap, 22);
});

test("combat target menu remains populated when guns are empty", () => {
  const world = createFreeWorld();
  startThreatEncounter(world, 2, "test-contract");
  const combat = world.players[0].combat;
  combat.pistolAmmo = 0;
  combat.ammo = 0;
  let chosen = null;
  const menu = createTargetMenu({
    getWorld: () => world,
    getPlayerIndex: () => 0,
    getTargetId: () => chosen,
    setTargetId: value => { chosen = value; },
    releaseMovement() {},
    sendInput() {},
    announce() {},
    render() {},
  });
  menu.open();
  const snapshot = menu.snapshot();
  assert.ok(snapshot.targets.length > 0);
  assert.equal(snapshot.targets.some(id => id.startsWith("navigation-")), false);
});

test("heavy threat uses 700 solo hull, 1000 coop hull and a long burst", () => {
  const solo = createFreeWorld();
  const soloHeavy = startHeavyPursuer(solo, 1, {x: 80, y: 120}, 0);
  assert.equal(soloHeavy.maxHull, 700);

  const coop = createFreeWorld();
  setPlayerPresence(coop, 1, true);
  const heavy = startHeavyPursuer(coop, 2, {x: 80, y: 120}, 0);
  assert.equal(heavy.maxHull, 1000);
  const target = coop.boats[0];
  target.x = heavy.x;
  target.y = heavy.y - 100;
  heavy.heading = 0;
  heavy.turretHeading = 0;
  heavy.fireCooldown = 0;
  for (let elapsed = 0; elapsed < 8; elapsed += 0.05) updateHeavyPursuer(coop, 0.05, {});
  assert.ok(coop.events.filter(event => event.type === "heavy-gun-shot").length >= 20);
});

test("audio wrappers target the same audio class as the live client", async () => {
  const pistolSource = await readFile(new URL("../public/src/free-roam-pistol-audio.js", import.meta.url), "utf8");
  const qualitySource = await readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  const clientSource = await readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");
  assert.match(pistolSource, /free-roam-audio-v5\.js\?v=43/);
  assert.match(qualitySource, /free-roam-audio-v5\.js\?v=43/);
  assert.match(clientSource, /free-roam-audio-v5\.js\?v=43/);
  assert.match(pistolSource, /163456__lemudcrab__pistol-shot\.wav/);
});
