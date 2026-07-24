import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {CONTRACT_BOARD} from "../public/src/free-roam-contracts.js";
import {activeEnemyBoats} from "../public/src/free-roam-enemy-boats.js";
import {activatePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";
import {isBoatDockPosition} from "../public/src/free-roam-cargo-rules.js";
import {MERCHANT, SHOP_ITEMS} from "../public/src/free-roam-shop.js";
import {createTargetMenu} from "../public/src/free-roam-target-menu.js";
import {listCombatTargets} from "../public/src/free-roam-targeting.js";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function tap(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  run(world, 0.08);
  setPlayerInput(world, playerIndex, {});
  run(world, 0.08);
}

function acceptCategory(world, category) {
  world.freeScenario.phase = "victory";
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = CONTRACT_BOARD.x;
  player.y = CONTRACT_BOARD.y;
  tap(world, 0, {action: true});
  world.freeContracts.boardSelection[0] = world.freeContracts.offers.findIndex(offer => offer.category === category);
  tap(world, 0, {boardAccept: true});
  const active = world.freeContracts.activeContract;
  const crate = world.freeActivities.crates.find(candidate => candidate.id === active.crateId);
  return {active, crate};
}

test("dangerous cargo starts its threat on first pickup and never retriggers", () => {
  const world = createFreeWorld();
  const {active, crate} = acceptCategory(world, "dangerous");
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = crate.x;
  player.y = crate.y;

  tap(world, 0, {action: true});
  assert.equal(player.combat.carriedCrate, crate.id);
  assert.equal(active.threatTriggered, true);
  assert.ok(active.threatTriggeredAt != null);
  const firstStarts = world.events.filter(event => event.type === "contract-threat-start" || event.type === "contract-threat-observed").length;
  assert.equal(firstStarts, 1);

  tap(world, 0, {action: true});
  tap(world, 0, {action: true});
  const repeatedStarts = world.events.filter(event => event.type === "contract-threat-start" || event.type === "contract-threat-observed").length;
  assert.equal(repeatedStarts, 1);
});

test("threat one creates an audible observer without becoming a combat target", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  startThreatEncounter(world, 1, "observer-contract");
  const observer = world.freeEnemyBoats.boats[0];
  assert.equal(observer.role, "observer");
  assert.equal(observer.hostile, false);
  assert.equal(world.freeContracts.encounterActive, false);
  assert.equal(activeEnemyBoats(world).length, 0);
  assert.equal(listCombatTargets(world, 0).some(target => target.id === observer.id), false);
  run(world, 18.2);
  assert.equal(observer.active, false);
  assert.ok(world.events.some(event => event.type === "observer-departed"));
});

test("a nearby salvage teammate helps only after starting their own work", () => {
  const world = createFreeWorld();
  const {crate} = acceptCategory(world, "salvage");
  setPlayerPresence(world, 1, true);
  for (const player of world.players) {
    player.mode = "foot";
    player.activeBoat = null;
    player.x = crate.x;
    player.y = crate.y;
  }

  tap(world, 0, {action: true});
  const beforeSolo = crate.extractionProgress;
  run(world, 0.8);
  const soloDelta = crate.extractionProgress - beforeSolo;
  assert.equal(world.freeSalvageWork.workers[1], null);

  tap(world, 1, {action: true});
  const beforeCoop = crate.extractionProgress;
  run(world, 0.8);
  const coopDelta = crate.extractionProgress - beforeCoop;
  assert.ok(coopDelta > soloDelta * 1.4, `solo ${soloDelta}, coop ${coopDelta}`);
});


test("a stopped boat can be left into open water without changing gesture controls", async () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  boat.x = 70;
  boat.y = 220;
  boat.speed = 0;
  world.boats[1].x = 350;
  world.boats[1].y = 120;
  for (const crate of world.freeActivities.crates) {
    crate.state = "consumed";
    crate.x = 350;
    crate.y = 300;
  }

  tap(world, 0, {action: true});
  assert.equal(player.mode, "swim");
  assert.equal(player.activeBoat, null);
  assert.equal(boat.driver, null);

  const source = await readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");
  assert.match(source, /targetMenuGestureAction\(metrics\)/);
  assert.match(source, /action === "previous"\) targetMenu\.cycle\(-1\)/);
  assert.match(source, /action === "next"\) targetMenu\.cycle\(1\)/);
  assert.match(source, /targetMenu\.confirm\(\)/);
  assert.match(source, /targetMenu\.close\(true\)/);
});

test("blocked dangerous delivery speaks once per dock visit", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  const boat = world.boats[0];
  const crate = world.freeActivities.crates[0];
  crate.id = "blocked-contract-crate";
  crate.state = "stowed";
  crate.contractId = "blocked-contract";
  crate.contractCategory = "dangerous";
  crate.singleUse = true;
  crate.stowedBoat = boat.id;
  boat.cargo = [crate.id];
  boat.driver = 0;
  boat.x = 210;
  boat.y = 82;
  boat.speed = 0;
  world.freeContracts.activeContract = {
    id: "blocked-contract",
    definitionId: "unused",
    category: "dangerous",
    label: "опасный груз",
    crateId: crate.id,
    phase: "combat",
    threatTriggered: true,
    rewardIssued: false,
  };
  world.freeContracts.encounterActive = true;
  world.freeContracts.encounterDefeated = false;

  run(world, 2);
  assert.equal(world.events.filter(event => event.type === "contract-delivery-blocked").length, 1);
  boat.y = 150;
  run(world, 0.2);
  boat.y = 82;
  run(world, 0.6);
  assert.equal(world.events.filter(event => event.type === "contract-delivery-blocked").length, 2);
});

test("merchant recovers a sunk owned boat from anywhere and preserves cargo", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  const player = world.players[0];
  const boat = world.boats[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = MERCHANT.x;
  player.y = MERCHANT.y;
  boat.sunk = true;
  boat.x = 60;
  boat.y = 290;
  boat.cargo = ["kept-cargo"];
  world.freeActivities.credits = 0;

  tap(world, 0, {action: true});
  world.freeActivities.shopSelection[0] = SHOP_ITEMS.findIndex(item => item.id === "wreck-recovery");
  tap(world, 0, {shopBuy: true});

  assert.equal(boat.sunk, false);
  assert.equal(isBoatDockPosition(boat), true);
  assert.equal(boat.hull, 20);
  assert.equal(boat.water, 35);
  assert.equal(boat.engineStalled, true);
  assert.deepEqual(boat.cargo, ["kept-cargo"]);
  assert.equal(world.freeActivities.freeWreckRecoveryUsed[0], true);
});

test("opening pursuit and contract combat hide navigation sonar but keep combat targets", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "pursuit";
  world.freeActivities.marauder.active = true;
  world.freeActivities.marauder.destroyed = false;
  activatePursuerSquad(world);
  assert.equal(scenarioTarget(world, 0), null);

  const menu = createTargetMenu({
    getWorld: () => world,
    getPlayerIndex: () => 0,
    getTargetId: () => null,
    setTargetId: () => {},
    getNavigationTargetId: () => "merchant",
    setNavigationTargetId: () => {},
    releaseMovement: () => {},
    sendInput: () => {},
    announce: () => {},
    render: () => {},
  });
  menu.open();
  const targets = menu.snapshot().targets;
  assert.ok(targets.length > 0);
  assert.equal(targets.some(id => id.startsWith("navigation-")), false);
  tap(world, 0, {sonar: true});
  assert.ok(world.events.some(event => event.type === "scenario-sonar-combat"));
});

test("destroyed selected enemy automatically advances to another combat target", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  startThreatEncounter(world, 3, "auto-target-contract");
  const primary = world.freeActivities.marauder;
  const combat = world.players[0].combat;
  combat.lockedTargetId = primary.id;
  world.freeActivities.inputs[0].targetId = primary.id;
  world.freeActivities.previousInputs[0].targetId = primary.id;
  primary.active = false;
  primary.destroyed = true;
  primary.hull = 0;

  stepFreeWorld(world, 0.05);
  assert.ok(combat.lockedTargetId);
  assert.notEqual(combat.lockedTargetId, primary.id);
  assert.ok(world.events.some(event => event.type === "target-auto-locked"));
});
