import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  snapshotWorld,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {
  applyWorldDelta,
  compactWorldSnapshot,
  createReplicatedWorld,
  createWorldDelta,
} from "../public/src/free-roam-world-delta.js";
import {grantWeaponFromCrate} from "../public/src/free-roam-weapon-crates.js";

test("the automatic crate grants a one hundred round magazine", () => {
  const world = createFreeWorld();
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "automatic");
  const messages = [];

  assert.equal(grantWeaponFromCrate(world, crate, 0, (...args) => messages.push(args)), true);
  assert.equal(world.players[0].combat.ammo, 100);
  assert.equal(world.players[0].combat.equipped, "automatic");
  assert.match(messages[0]?.[2] || "", /Боезапас 100/);
});

test("the peer view omits host inputs, AI cooldowns, and projectile physics", () => {
  const world = createFreeWorld();
  world.freePursuerSquad.projectiles.push({
    id: "bullet-1", x: 1, y: 2, vx: 64, vy: -10, ttl: 7, damage: 3, nearMissAnnounced: [false, false],
  });
  world.freePursuerSquad.escorts.push({
    id: "pursuer-2", x: 4, y: 5, active: true, destroyed: false, fireCooldown: 0.2, burstCooldown: 0.1,
  });

  const view = createReplicatedWorld(world);
  assert.equal(Object.hasOwn(view, "inputs"), false);
  assert.equal(Object.hasOwn(view, "operationInputs"), false);
  assert.deepEqual(view.freePursuerSquad.projectiles[0], {id: "bullet-1", x: 1, y: 2});
  assert.equal(Object.hasOwn(view.freePursuerSquad.escorts[0], "fireCooldown"), false);
  assert.equal(Object.hasOwn(view.freePursuerSquad.escorts[0], "burstCooldown"), false);
});

test("world deltas reproduce moving state, additions, and removals exactly", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  const hostBaseline = compactWorldSnapshot(snapshotWorld(world));
  let guestWorld = compactWorldSnapshot(snapshotWorld(world));

  world.inputs[0].up = true;
  world.inputs[1].left = true;
  world.freePursuerSquad.projectiles.push({id: "bullet-1", x: 12, y: 24, ttl: 3});
  stepFreeWorld(world, 0.033);
  drainEvents(world);
  let delta = createWorldDelta(world, hostBaseline);
  guestWorld = applyWorldDelta(guestWorld, delta);
  assert.deepEqual(guestWorld, hostBaseline);

  world.freePursuerSquad.projectiles[0].x = 18.123456;
  world.freePursuerSquad.projectiles.push({id: "bullet-2", x: 8, y: 9, ttl: 2});
  world.boats[0].cargo.push("crate-test");
  delta = createWorldDelta(world, hostBaseline);
  guestWorld = applyWorldDelta(guestWorld, delta);
  assert.deepEqual(guestWorld, hostBaseline);
  assert.equal(guestWorld.freePursuerSquad.projectiles[0].x, 18.123);

  world.freePursuerSquad.projectiles.splice(0, 1);
  world.boats[0].cargo.length = 0;
  delete world.freeScenario.announced;
  delta = createWorldDelta(world, hostBaseline);
  guestWorld = applyWorldDelta(guestWorld, delta);
  assert.deepEqual(guestWorld, hostBaseline);
});

test("steady movement delta is much smaller than a full world snapshot", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  world.inputs[0].up = true;
  world.inputs[1].up = true;
  const baseline = compactWorldSnapshot(createReplicatedWorld(world));

  // The first frame initializes a few lazy subsystems. Measure the stable
  // packet that follows, which is what is sent throughout normal movement.
  stepFreeWorld(world, 0.033);
  drainEvents(world);
  createWorldDelta(createReplicatedWorld(world), baseline);
  stepFreeWorld(world, 0.033);
  drainEvents(world);
  const delta = createWorldDelta(createReplicatedWorld(world), baseline);
  const fullBytes = JSON.stringify(compactWorldSnapshot(createReplicatedWorld(world))).length;
  const deltaBytes = JSON.stringify(delta).length;

  assert.ok(deltaBytes < fullBytes * 0.12, `${deltaBytes} should be under 12% of ${fullBytes}`);
});
