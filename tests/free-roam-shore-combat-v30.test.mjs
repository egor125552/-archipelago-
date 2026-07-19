import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {relativeMovementPan} from "../public/src/free-roam-audio-v3.js";

function run(world, seconds, dt = 0.02) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

function tap(world, playerIndex, control, hold = 0.04) {
  setPlayerInput(world, playerIndex, {[control]: true});
  const events = run(world, hold);
  setPlayerInput(world, playerIndex, {[control]: false});
  events.push(...run(world, 0.04));
  return events;
}

test("a tiny footstep across a nearby sonar line cannot flip full stereo sides", () => {
  const target = {x: 136, y: 34};
  const before = relativeMovementPan({mode: "foot", x: 135.9, y: 34}, target);
  const after = relativeMovementPan({mode: "foot", x: 136.1, y: 34}, target);

  assert.ok(Math.abs(before) < 0.1);
  assert.ok(Math.abs(after) < 0.1);
  assert.ok(Math.abs(before - after) < 0.1);
});

test("shore crates line up with their reachable landing instead of jumping sideways after exit", () => {
  const world = createFreeWorld();
  const shoreCrates = world.freeActivities.crates.filter(crate => crate.y <= 72);

  assert.ok(shoreCrates.length > 0);
  assert.ok(shoreCrates.every(crate => crate.x >= 162 && crate.x <= 258));
});

test("the exact twelve metre double-signal boundary also allows F to pick up the crate", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "plates");
  Object.assign(player, {mode: "foot", activeBoat: null, x: crate.x + 12, y: crate.y});
  world.freeScenario.lockedTargetIds[0] = crate.id;

  const approachEvents = run(world, 0.08);
  const actionEvents = tap(world, 0, "action");

  assert.ok(approachEvents.some(event => event.type === "scenario-arrival"));
  assert.equal(crate.state, "carried");
  assert.ok(actionEvents.some(event => event.type === "cargo-pickup"));
  assert.equal(actionEvents.some(event => event.type === "action-denied"), false);
});

test("walking into the dock with a carried crate unloads it without F", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "plates");
  Object.assign(player, {mode: "foot", activeBoat: null, x: 210, y: 65});
  Object.assign(crate, {state: "carried", carriedBy: 0, stowedBoat: null, x: player.x, y: player.y});
  player.combat.carriedCrate = crate.id;

  const events = run(world, 1);

  assert.equal(player.combat.carriedCrate, null);
  assert.equal(crate.state, "delivered");
  assert.equal(events.filter(event => event.type === "cargo-delivered").length, 1);
});
