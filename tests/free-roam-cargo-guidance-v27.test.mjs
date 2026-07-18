import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";

function run(world, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

test("a boat is guided to the landing instead of through the shore for a land crate", () => {
  const world = createFreeWorld();
  world.freeScenario.lockedTargetIds[0] = "crate-plates";

  const target = scenarioTarget(world, 0);

  assert.equal(target.id, "landing-crate-plates");
  assert.equal(target.kind, "landing");
  assert.ok(target.x >= 154 && target.x <= 266);
  assert.ok(target.y > 72);
});

test("after disembarking the same locked land crate becomes the direct target", () => {
  const world = createFreeWorld();
  world.freeScenario.lockedTargetIds[0] = "crate-plates";
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 200, y: 65});

  const target = scenarioTarget(world, 0);

  assert.equal(target.id, "crate-plates");
  assert.equal(target.kind, "plates");
});

test("choosing a land-crate landing replaces the previous delivered crate lock", () => {
  const world = createFreeWorld();
  const pump = world.freeActivities.crates.find(crate => crate.id === "crate-pump");
  const value = world.freeActivities.crates.find(crate => crate.id === "crate-value");
  pump.state = "delivered";
  pump.respawnAt = world.time + 0.2;
  value.state = "delivered";
  value.respawnAt = world.time + 10;
  world.freeScenario.lockedTargetIds[0] = "crate-pump";

  run(world, 0.1);

  assert.equal(world.freeScenario.targets[0].id, "landing-crate-plates");
  assert.equal(world.freeScenario.lockedTargetIds[0], "crate-plates");

  run(world, 0.3);
  assert.equal(world.freeScenario.targets[0].id, "landing-crate-plates");
});

test("entering a cargo action zone announces one clear double-signal prompt", () => {
  const world = createFreeWorld();
  run(world, 0.1);
  const target = world.freeScenario.targets[0];
  const boat = world.boats[0];
  Object.assign(boat, {x: target.x, y: target.y + 11, speed: 0});
  Object.assign(world.players[0], {x: boat.x, y: boat.y});

  const first = run(world, 0.2).filter(event => event.type === "scenario-arrival");
  const repeated = run(world, 1).filter(event => event.type === "scenario-arrival");

  assert.equal(first.length, 1);
  assert.match(first[0].text, /двойной сигнал|нажми F/i);
  assert.equal(repeated.length, 0);
});

test("a joining player appears beside a shore player instead of far away", () => {
  const world = createFreeWorld();
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 205, y: 60});

  setPlayerPresence(world, 1, true);

  assert.equal(world.players[1].mode, "foot");
  assert.ok(Math.hypot(world.players[1].x - 205, world.players[1].y - 60) <= 8);
});

test("a leaking boat moored at the landing does not fill while its player fetches a land crate", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  Object.assign(boat, {x: 205, y: 84, driver: null, leak: 5, water: 20, speed: 0});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 205, y: 65});

  run(world, 5);

  assert.equal(boat.water, 20);
});
