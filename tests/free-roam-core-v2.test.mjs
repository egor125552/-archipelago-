import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v2.js";

function stepMany(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function near(actual, expected, tolerance = 0.08) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("manual pump uses the operation water rates", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.water = 20;
  boat.leak = 3;
  setPlayerInput(world, 0, {pump: true});
  stepMany(world, 1);
  near(boat.water, 20 + 3 * 0.33 - 7.5);
  assert.equal(boat.pumpActive, true);
  assert.ok(drainEvents(world).some(event => event.type === "pump-start"));
});

test("one repair plate keeps the operation duration and repair amounts", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.hull = 45;
  boat.leak = 4;
  const patches = boat.repairPatches;
  setPlayerInput(world, 0, {repair: true});
  stepMany(world, 3.15);
  near(boat.hull, 67, 0.05);
  near(boat.leak, 0.8, 0.05);
  assert.equal(boat.repairPatches, patches - 1);
  assert.ok(drainEvents(world).some(event => event.type === "hull-repair-complete"));
});

test("full flooding starts the 45 second operation recovery window", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.water = 100;
  boat.hull = 0.05;
  stepFreeWorld(world, 0.05);
  assert.equal(boat.emergencyActive, true);
  assert.ok(boat.emergencyRemaining > 44 && boat.emergencyRemaining <= 45);
  assert.ok(drainEvents(world).some(event => event.type === "flood-emergency-start"));

  setPlayerInput(world, 0, {pump: true, repair: true});
  stepMany(world, 10);
  assert.equal(boat.sunk, false);
  assert.equal(boat.emergencyActive, false);
  assert.ok(boat.water <= 35);
  assert.ok(boat.hull >= 5);
  assert.ok(drainEvents(world).some(event => event.type === "flood-emergency-recovered"));
});

test("a towed boat can install a plate while moving", () => {
  const world = createFreeWorld();
  world.boats[0].x = 180;
  world.boats[0].y = 150;
  world.boats[1].x = 198;
  world.boats[1].y = 150;
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {up: true});
  world.boats[1].hull = 45;
  world.boats[1].leak = 4;
  setPlayerInput(world, 1, {repair: true});
  stepMany(world, 3.3);
  assert.ok(world.boats[1].hull >= 67);
  assert.ok(world.boats[1].speed !== 0 || world.boats[1].x !== 198 || world.boats[1].y !== 150);
});
