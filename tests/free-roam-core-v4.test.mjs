import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v4.js";

function stepMany(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

test("free roam uses operation steering authority and centers the rudder on release", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {up: true});
  stepMany(world, 1.2);
  const before = world.boats[0].heading;
  setPlayerInput(world, 0, {up: true, right: true});
  stepMany(world, 0.5);
  assert.ok(Math.abs(world.boats[0].heading - before) > 12, "boat should turn decisively while the wheel is held");
  assert.ok(world.boats[0].rudder > 0);

  setPlayerInput(world, 0, {up: true});
  stepFreeWorld(world, 0.05);
  assert.equal(world.boats[0].rudder, 0);
  assert.ok(drainEvents(world).some(event => event.type === "turn-complete"));
});

test("F still attaches the existing physical tow rope", () => {
  const world = createFreeWorld();
  world.boats[0].x = 180;
  world.boats[0].y = 150;
  world.boats[1].x = 198;
  world.boats[1].y = 150;
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  assert.ok(world.tow);
  assert.equal(world.tow.towerBoat, 0);
  assert.equal(world.tow.towedBoat, 1);
});

test("space uses the familiar floating brake while driving", () => {
  const world = createFreeWorld();
  world.boats[0].speed = 10;
  setPlayerInput(world, 0, {jump: true});
  stepFreeWorld(world, 0.05);
  assert.ok(Math.abs(world.boats[0].speed) <= 0.13);
  assert.ok(drainEvents(world).some(event => event.type === "anchor"));
});

test("walking steps are broadcast with source position and movement side", () => {
  const world = createFreeWorld();
  world.boats[0].x = 180;
  world.boats[0].y = 80;
  world.boats[0].speed = 0;
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  assert.equal(world.players[0].mode, "foot");
  drainEvents(world);

  setPlayerInput(world, 0, {right: true});
  stepFreeWorld(world, 0.05);
  const step = drainEvents(world).find(event => event.type === "footstep");
  assert.ok(step);
  assert.deepEqual(step.targets, [0, 1]);
  assert.equal(step.sourcePlayer, 0);
  assert.equal(step.movementPan, 1);
  assert.ok(Number.isFinite(step.x) && Number.isFinite(step.y));
});
