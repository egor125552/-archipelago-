import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v7.js";

function pulse(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {});
  stepFreeWorld(world, 0.05);
}

test("one emergency canister fills the active boat to exactly 100 percent", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  player.mode = "boat";
  player.activeBoat = boat.id;
  boat.driver = 0;
  boat.speed = 0;
  boat.throttle = 0;
  boat.fuel = 0;
  boat.refuelCanisters = 1;
  boat.engineTemp = 50;
  boat.water = 0;
  boat.hull = 100;
  boat.emergencyActive = false;
  boat.pumpActive = false;
  drainEvents(world);

  pulse(world, 0, {action: true});
  assert.equal(boat.refuelActive, true);

  let completed = null;
  for (let index = 0; index < 60 && !completed; index += 1) {
    stepFreeWorld(world, 0.1);
    completed = world.events.find(event => event.type === "fuel-refuel-complete") || null;
  }

  assert.ok(completed, "refuel completion event was not emitted");
  assert.equal(boat.refuelActive, false);
  assert.equal(boat.refuelCanisters, 0);
  assert.equal(boat.fuel, 100);
  assert.equal(completed.fuel, 100);
  assert.match(completed.text || "", /Топливо 100%/);
});
