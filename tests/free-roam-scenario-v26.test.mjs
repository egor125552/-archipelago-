import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  playerStatus,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";

function run(world, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

function pulse(world, control, hold = 0.08) {
  setPlayerInput(world, 0, {[control]: true});
  const events = run(world, hold);
  setPlayerInput(world, 0, {[control]: false});
  events.push(...run(world, 0.08));
  return events;
}

function deliver(world, kind) {
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === kind);
  const boat = world.boats[0];
  crate.state = "stowed";
  crate.stowedBoat = 0;
  crate.carriedBy = null;
  if (!boat.cargo.includes(crate.id)) boat.cargo.push(crate.id);
  Object.assign(boat, {x: 200, y: 82, speed: 0});
  return run(world, 1.2);
}

test("the pursuer stays away until salvage and weapon objectives are complete", () => {
  const world = createFreeWorld();
  assert.equal(world.freeScenario.phase, "salvage");
  assert.equal(world.freeActivities.marauder.active, false);

  run(world, 60);
  assert.equal(world.freeActivities.marauder.active, false);
  assert.match(playerStatus(world, 0), /доставь ещё два/i);

  deliver(world, "plates");
  deliver(world, "fuel");
  assert.equal(world.freeScenario.phase, "arm");
  assert.match(playerStatus(world, 0), /автомат/i);

  deliver(world, "automatic");
  assert.equal(world.players[0].combat.weapons.automatic, true);
  assert.equal(world.freeScenario.phase, "warning");
  assert.equal(world.freeActivities.marauder.active, false);

  const events = run(world, 9);
  assert.equal(world.freeScenario.phase, "pursuit");
  assert.equal(world.freeActivities.marauder.active, true);
  assert.ok(events.some(event => event.type === "pursuer-arrival"));
});

test("sonar reports exactly one current objective and opens one temporary beacon", () => {
  const world = createFreeWorld();
  drainEvents(world);
  const events = pulse(world, "sonar");
  const sonarEvents = events.filter(event => event.type === "scenario-sonar");
  assert.equal(sonarEvents.length, 1);
  assert.ok(sonarEvents[0].targetId);
  assert.match(sonarEvents[0].text, /Сонар: цель/i);
  assert.equal(world.freeScenario.targets[0].id, sonarEvents[0].targetId);
  assert.ok(world.freeScenario.beaconUntil[0] > world.time);
});

test("sonar keeps the same crate locked while the player moves across nearest-crate boundaries", () => {
  const world = createFreeWorld();
  run(world, 0.1);
  const locked = world.freeScenario.targets[0];
  assert.ok(locked?.id?.startsWith("crate-"));

  const other = world.freeActivities.crates.find(crate => crate.state === "world" && crate.id !== locked.id);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: other.x, y: other.y});
  run(world, 0.1);

  assert.equal(world.freeScenario.targets[0].id, locked.id);
});

test("one sonar press keeps guidance active long enough to reach a distant crate", () => {
  const world = createFreeWorld();
  pulse(world, "sonar");
  run(world, 15);
  assert.ok(world.freeScenario.beaconUntil[0] > world.time);
});

test("loading a nearby crate does not also announce that action F failed", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.state === "world");
  Object.assign(crate, {x: boat.x + 5, y: boat.y});

  const events = pulse(world, "action");

  assert.ok(events.some(event => event.type === "cargo-stowed"));
  assert.equal(events.some(event => event.type === "action-denied"), false);
});

test("on foot the spoken side of a locked target stays world-stable after a sideways step", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  Object.assign(player, {mode: "foot", activeBoat: null, x: 100, y: 50, heading: 0});
  world.freeScenario.lockedTargetIds[0] = "crate-plates";
  run(world, 0.1);
  const first = pulse(world, "sonar").find(event => event.type === "scenario-sonar");
  assert.match(first.text, /справа/i);

  run(world, 1.2);
  Object.assign(player, {x: 101, heading: 90});
  const second = pulse(world, "sonar").find(event => event.type === "scenario-sonar");
  assert.match(second.text, /справа/i);
});

test("a player ram hits first and separates the boats instead of gluing them together", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  const pursuer = world.freeActivities.marauder;
  world.freeScenario.phase = "pursuit";
  Object.assign(boat, {x: 200, y: 180, heading: 90, speed: 12, driver: 0});
  Object.assign(pursuer, {
    x: 210,
    y: 180,
    heading: 270,
    speed: 0,
    hull: 72,
    active: true,
    destroyed: false,
    ramCooldown: 0,
    recoveryRemaining: 0,
  });

  const events = run(world, 0.1);
  assert.ok(events.some(event => event.type === "pursuer-hit"));
  assert.ok(pursuer.hull < 72);
  assert.ok(Math.hypot(boat.x - pursuer.x, boat.y - pursuer.y) >= 15);
  assert.ok(pursuer.recoveryRemaining > 0);
});

test("an enemy ram also pushes the pursuer away and starts a recovery run", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  const pursuer = world.freeActivities.marauder;
  world.freeScenario.phase = "pursuit";
  Object.assign(boat, {x: 200, y: 180, speed: 0, driver: 0});
  Object.assign(pursuer, {
    x: 209,
    y: 180,
    heading: 270,
    speed: 14,
    active: true,
    destroyed: false,
    ramCooldown: 0,
    recoveryRemaining: 0,
  });

  const events = run(world, 0.1);
  assert.ok(events.some(event => event.type === "pursuer-ram"));
  assert.ok(Math.hypot(boat.x - pursuer.x, boat.y - pursuer.y) >= 15);
  assert.ok(pursuer.recoveryRemaining > 0);
});

test("punching an armoured pursuer clearly explains the valid attacks", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const pursuer = world.freeActivities.marauder;
  world.freeScenario.phase = "pursuit";
  Object.assign(player, {mode: "swim", activeBoat: null, x: 200, y: 180, heading: 90});
  Object.assign(pursuer, {x: 204, y: 180, active: true, destroyed: false});
  const events = pulse(world, "attack", 0.12);
  const denied = events.find(event => event.type === "armoured-target");
  assert.ok(denied);
  assert.match(denied.text, /автомат|таран/i);
});
