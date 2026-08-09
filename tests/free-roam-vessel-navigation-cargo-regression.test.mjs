import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
} from "../public/src/free-roam-core-v7.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "../public/src/vessel/systems/vessel-deck-input-bridge-system.js";
import {
  relativeVesselPan,
  vesselUsesCustomEngineAudio,
} from "../public/src/vessel/vessel-audio-policy.js";

test("generic vessel navigation ids survive the shared input pipeline", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {navigationTargetId: "vessel:42"});
  assert.equal(world.freeActivities.inputs[0].navigationTargetId, "vessel:42");
});

test("cargo on an old owned boat does not redirect a swimmer to the dock", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const oldBoat = world.boats[0];
  const pump = world.freeActivities.crates.find(crate => crate.id === "crate-pump");
  const fuel = world.freeActivities.crates.find(crate => crate.id === "crate-fuel");

  assert.ok(player && oldBoat && pump && fuel);
  world.freeScenario.phase = "salvage";
  world.freeScenario.navigationModes[0] = "objective";
  world.freeScenario.lockedTargetIds[0] = fuel.id;

  pump.state = "stowed";
  pump.carriedBy = null;
  pump.stowedBoat = oldBoat.id;
  oldBoat.cargo = [pump.id];

  fuel.state = "world";
  fuel.carriedBy = null;
  fuel.stowedBoat = null;

  player.mode = "swim";
  player.activeBoat = null;
  player.combat.carriedCrate = null;

  const onFootTarget = scenarioTarget(world, 0);
  assert.equal(onFootTarget?.id, fuel.id, "old boat cargo must not hijack the current shore objective");

  player.mode = "boat";
  player.activeBoat = oldBoat.id;
  const aboardTarget = scenarioTarget(world, 0);
  assert.equal(aboardTarget?.kind, "dock", "cargo on the current active boat should still route to unloading");
});

test("cargo action from an occupied vessel station does not also leave the station", () => {
  const before = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "before-input");
  const after = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "after-input");
  assert.ok(before && after);

  const station = {
    id: "test-helm-seat",
    kind: "station",
    resourceId: "test-helm-control",
    stationRole: "helm",
    controlsVessel: true,
  };
  const entry = {
    boat: {id: 3},
    definition: {
      deckArchitecture: {enabled: true},
      decks: [{id: "test-deck", objects: [station]}],
    },
    instance: {
      occupants: {0: {deckId: "test-deck", x: 0, y: 0}},
      interior: {claims: {"test-helm-control": 0}},
    },
  };
  const world = {
    players: [{activeBoat: 3, x: 0, y: 0, combat: {carriedCrate: null}}],
    inputs: [{action: false}],
    operationInputs: [{action: false}],
    previousInputs: [{action: false}],
    operationPreviousInputs: [{action: false}],
    freeActivities: {
      crates: [{id: "nearby-cargo", state: "world", x: 2, y: 0}],
      inputs: [{action: false}],
      previousInputs: [{action: false}],
    },
  };
  const input = {action: true, attack: false, pump: false, repair: false, guide: false};

  before.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(input.action, false, "deck interaction must not receive leave-station when cargo owns this press");
  after.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(world.freeActivities.inputs[0].action, true, "legacy cargo system must still receive the stow action");

  world.freeActivities.crates[0].x = 40;
  const leaveInput = {action: true, attack: false, pump: false, repair: false, guide: false};
  before.run({world, nativeVessels: [entry], playerIndex: 0, input: leaveInput});
  assert.equal(leaveInput.action, true, "without cargo, the same action remains available to leave the station");
});

test("foot and swim vessel audio stays world-anchored when the listener turns", () => {
  const east = {x: 10, y: 0};
  const west = {x: -10, y: 0};

  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 0, mode: "foot"}, east), 1);
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 180, mode: "foot"}, east), 1, "turning in place must not throw the same boat into the opposite ear");
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 90, mode: "swim"}, east), 1, "swimming keeps the same world-anchored navigation convention");
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: -90, mode: "foot"}, west), -1);

  const beforeCrossing = relativeVesselPan({x: -4, y: 0, heading: 180, mode: "foot"}, {x: 0, y: 0});
  const afterCrossing = relativeVesselPan({x: 4, y: 0, heading: 180, mode: "foot"}, {x: 0, y: 0});
  assert.ok(beforeCrossing > 0 && afterCrossing < 0, "the ear changes only after the listener actually crosses the vessel in world space");

  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "standard"}), false);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "stress-50-engine-v2"}), true);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "medium-crew-v1"}), true);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "dual-turret-heavy"}), true);
});
