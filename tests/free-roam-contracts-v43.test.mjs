import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {CONTRACT_CARGO_CATALOG, NORMAL_CONTRACT_CARGO, SALVAGE_CONTRACT_CARGO, DANGEROUS_CONTRACT_CARGO} from "../public/src/free-roam-contract-catalog.js";
import {CONTRACT_BOARD, completeContractDelivery, ensureContracts} from "../public/src/free-roam-contracts.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function tap(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  run(world, 0.06);
  setPlayerInput(world, playerIndex, {});
  run(world, 0.06);
}

function unlockBoard(world) {
  world.freeScenario.phase = "victory";
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = CONTRACT_BOARD.x;
  player.y = CONTRACT_BOARD.y;
}

function openAndAccept(world, selection = 0) {
  unlockBoard(world);
  tap(world, 0, {action: true});
  world.freeContracts.boardSelection[0] = selection;
  tap(world, 0, {boardAccept: true});
  return world.freeContracts.activeContract;
}

test("contract catalogue contains 96 unique manually named cargo definitions", () => {
  assert.equal(NORMAL_CONTRACT_CARGO.length, 36);
  assert.equal(SALVAGE_CONTRACT_CARGO.length, 32);
  assert.equal(DANGEROUS_CONTRACT_CARGO.length, 28);
  assert.equal(CONTRACT_CARGO_CATALOG.length, 96);
  assert.equal(new Set(CONTRACT_CARGO_CATALOG.map(item => item.id)).size, 96);
  assert.equal(new Set(CONTRACT_CARGO_CATALOG.map(item => item.label)).size, 96);
});

test("the contract board is locked until the opening pursuit is defeated", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = CONTRACT_BOARD.x;
  player.y = CONTRACT_BOARD.y;
  tap(world, 0, {action: true});
  assert.equal(world.freeContracts.boardOpen[0], false);
  world.freeScenario.phase = "victory";
  tap(world, 0, {action: true});
  assert.equal(world.freeContracts.boardOpen[0], true);
});

test("two players accepting at the same time still create one shared contract", () => {
  const world = createFreeWorld();
  unlockBoard(world);
  setPlayerPresence(world, 1, true);
  const second = world.players[1];
  second.mode = "foot";
  second.activeBoat = null;
  second.x = CONTRACT_BOARD.x;
  second.y = CONTRACT_BOARD.y;
  tap(world, 0, {action: true});
  tap(world, 1, {action: true});
  world.freeContracts.boardSelection[0] = 0;
  world.freeContracts.boardSelection[1] = 2;
  setPlayerInput(world, 0, {boardAccept: true});
  setPlayerInput(world, 1, {boardAccept: true});
  run(world, 0.06);
  assert.ok(world.freeContracts.activeContract);
  assert.equal(world.freeActivities.crates.filter(crate => crate.contractId).length, 1);
});

test("normal offers do not repeat while their deck still contains unseen cargo", () => {
  const world = createFreeWorld();
  const seen = [];
  for (let round = 0; round < 6; round += 1) {
    const normalOffer = world.freeContracts.offers.find(offer => offer.category === "normal");
    seen.push(normalOffer.definitionId);
    const selection = world.freeContracts.offers.indexOf(normalOffer);
    const active = openAndAccept(world, selection);
    const crate = world.freeActivities.crates.find(candidate => candidate.id === active.crateId);
    completeContractDelivery(world, 0, world.boats[0], crate);
    crate.state = "consumed";
  }
  assert.equal(new Set(seen).size, seen.length);
});

test("salvage requires physical extraction and a nearby teammate speeds it up", () => {
  const solo = createFreeWorld();
  const salvageIndex = solo.freeContracts.offers.findIndex(offer => offer.category === "salvage");
  const activeSolo = openAndAccept(solo, salvageIndex);
  const crateSolo = solo.freeActivities.crates.find(crate => crate.id === activeSolo.crateId);
  const playerSolo = solo.players[0];
  playerSolo.mode = "foot";
  playerSolo.x = crateSolo.x;
  playerSolo.y = crateSolo.y;
  setPlayerInput(solo, 0, {action: true});
  run(solo, 1);
  const soloProgress = crateSolo.extractionProgress;

  const coop = createFreeWorld();
  const coopIndex = coop.freeContracts.offers.findIndex(offer => offer.category === "salvage");
  const activeCoop = openAndAccept(coop, coopIndex);
  const crateCoop = coop.freeActivities.crates.find(crate => crate.id === activeCoop.crateId);
  setPlayerPresence(coop, 1, true);
  for (const player of coop.players) {
    player.mode = "foot";
    player.activeBoat = null;
    player.x = crateCoop.x;
    player.y = crateCoop.y;
  }
  setPlayerInput(coop, 0, {action: true});
  setPlayerInput(coop, 1, {action: true});
  run(coop, 1);
  assert.ok(crateCoop.extractionProgress > soloProgress * 1.4);
  assert.equal(crateCoop.extracted, crateCoop.extractionProgress >= crateCoop.extractionSeconds);
});

test("taking dangerous contract cargo starts combat and suspends navigation sonar", () => {
  const world = createFreeWorld();
  const dangerousIndex = world.freeContracts.offers.findIndex(offer => offer.category === "dangerous");
  const active = openAndAccept(world, dangerousIndex);
  const crate = world.freeActivities.crates.find(candidate => candidate.id === active.crateId);
  const boat = world.boats[0];
  const player = world.players[0];
  player.mode = "boat";
  player.activeBoat = boat.id;
  boat.driver = 0;
  player.x = crate.x;
  player.y = crate.y;
  boat.x = crate.x;
  boat.y = crate.y;
  tap(world, 0, {action: true});
  assert.equal(world.freeContracts.encounterActive, true);
  assert.equal(world.freeContracts.encounterLevel, 2);
  assert.equal(world.freeContracts.activeContract.threatTriggered, true);
  assert.equal(scenarioTarget(world, 0), null);
  tap(world, 0, {sonar: true});
  assert.ok(world.events.some(event => event.type === "scenario-sonar-combat"));
});
