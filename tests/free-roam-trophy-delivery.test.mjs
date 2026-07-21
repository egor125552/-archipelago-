import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {spawnRareCrate} from "../public/src/free-roam-activities.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function tapAction(world) {
  setPlayerInput(world, 0, {action: true});
  run(world, 0.05);
  setPlayerInput(world, 0, {action: false});
  run(world, 0.05);
}

test("a pursuer trophy loads, unloads at the dock, and stops pointing to the dock afterward", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[player.activeBoat];
  world.freeScenario.phase = "victory";

  const trophy = spawnRareCrate(world, boat.x, boat.y, "ammo", "pursuer");
  tapAction(world);

  assert.equal(trophy.state, "stowed");
  assert.ok(boat.cargo.includes(trophy.id));
  assert.equal(scenarioTarget(world, 0)?.kind, "dock");

  boat.x = 210;
  boat.y = 90;
  boat.speed = 5;
  run(world, 0.6);

  assert.equal(boat.cargo.length, 0);
  assert.equal(trophy.state, "consumed");
  assert.equal(world.players[0].combat.ammo, 30);
  assert.equal(scenarioTarget(world, 0), null);
});

test("victory does not invent a dock target when no trophy is being carried", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  for (const crate of world.freeActivities.crates) {
    crate.state = "consumed";
    crate.carriedBy = null;
    crate.stowedBoat = null;
  }
  for (const boat of world.boats) boat.cargo = [];

  assert.equal(scenarioTarget(world, 0), null);
});
