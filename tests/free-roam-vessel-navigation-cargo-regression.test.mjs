import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
} from "../public/src/free-roam-core-v7.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";

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
