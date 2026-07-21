import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {predictLocalWorld, reconcileLocalPrediction} from "../public/src/free-roam-client-prediction.js";
import {
  applyReplicatedWorldDelta,
  diffReplicatedWorld,
  replicatedFreeWorld,
} from "../public/src/free-roam-replication.js";
import {grantWeaponFromCrate} from "../public/src/free-roam-weapon-crates.js";
import {activatePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";

test("the Durable Object simulation accepts both players' inputs and rejects stale commands", () => {
  const serverRoom = createServerFreeRoom(1_000);
  assert.deepEqual(serverRoom.world.freeActivities.presence, [false, false]);
  setServerFreePresence(serverRoom, "captain", true);
  setServerFreePresence(serverRoom, "crew", true);
  const before = serverRoom.world.boats.map(boat => ({x: boat.x, y: boat.y}));

  assert.equal(applyServerFreeInput(serverRoom, "captain", {up: true}, 1), true);
  assert.equal(applyServerFreeInput(serverRoom, "crew", {up: true, right: true}, 7), true);
  assert.equal(applyServerFreeInput(serverRoom, "crew", {down: true}, 6), false);
  const state = tickServerFreeRoom(serverRoom, 1_200);

  assert.deepEqual(state.ackInput, [1, 7]);
  assert.ok(Math.hypot(
    state.world.boats[0].x - before[0].x,
    state.world.boats[0].y - before[0].y,
  ) > 0.01);
  assert.ok(Math.hypot(
    state.world.boats[1].x - before[1].x,
    state.world.boats[1].y - before[1].y,
  ) > 0.01);
  assert.equal(serverRoom.world.inputs[1].up, true);
  assert.notEqual(serverRoom.world.inputs[1].down, true);
});

test("replication omits simulation internals and stays materially smaller than the full world", () => {
  const world = createFreeWorld();
  world.freePursuerSquad.projectiles.push({
    id: "bullet-test", x: 10.12349, y: 20.98761, vx: 70, vy: -4, ttl: 5,
  });
  world.freeHostileGunners.projectiles.push({
    id: "gunner-test", x: 30, y: 40, vx: -60, vy: 2, ttl: 3,
  });
  const replicated = replicatedFreeWorld(world);
  const fullBytes = Buffer.byteLength(JSON.stringify(world));
  const replicatedBytes = Buffer.byteLength(JSON.stringify(replicated));

  assert.equal("inputs" in replicated, false);
  assert.equal("events" in replicated, false);
  assert.equal("previousInputs" in replicated, false);
  assert.equal("collisionCooldown" in replicated.boats[0], false);
  assert.deepEqual(replicated.freePursuerSquad.projectiles[0], {
    id: "bullet-test", x: 10.123, y: 20.988,
  });
  assert.equal("vx" in replicated.freeHostileGunners.projectiles[0], false);
  assert.ok(replicatedBytes < fullBytes * 0.7, `${replicatedBytes} should be compact beside ${fullBytes}`);
  assert.ok(replicatedBytes < 4_000, `initial render state is unexpectedly large: ${replicatedBytes}`);
});

test("acknowledged render states round-trip through a small delta", () => {
  const serverRoom = createServerFreeRoom(3_000);
  setServerFreePresence(serverRoom, "captain", true);
  const previous = replicatedFreeWorld(serverRoom.world);
  applyServerFreeInput(serverRoom, "captain", {up: true, right: true}, 1);
  const next = tickServerFreeRoom(serverRoom, 3_040).world;
  const delta = diffReplicatedWorld(previous, next);
  const restored = applyReplicatedWorldDelta(previous, delta);
  const fullBytes = Buffer.byteLength(JSON.stringify(next));
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta));

  assert.deepEqual(restored, next);
  assert.ok(deltaBytes < fullBytes * 0.35, `${deltaBytes} delta bytes beside ${fullBytes} full bytes`);
});

test("local prediction responds immediately but a large server correction still wins", () => {
  const authoritative = replicatedFreeWorld(createFreeWorld());
  const predicted = structuredClone(authoritative);
  const boatBefore = {...predicted.boats[0]};
  predictLocalWorld(predicted, 0, {up: true, right: true}, 0.05);
  assert.notEqual(predicted.boats[0].y, boatBefore.y);

  const nearbyAuthority = structuredClone(authoritative);
  const blended = reconcileLocalPrediction(predicted, nearbyAuthority, 0);
  assert.notEqual(blended.boats[0].y, authoritative.boats[0].y);

  const correctedAuthority = structuredClone(authoritative);
  correctedAuthority.boats[0].x += 40;
  correctedAuthority.players[0].x += 40;
  const corrected = reconcileLocalPrediction(predicted, correctedAuthority, 0);
  assert.equal(corrected.boats[0].x, authoritative.boats[0].x + 40);
});

test("releasing predicted throttle keeps the same useful physical coast as the server", () => {
  const world = replicatedFreeWorld(createFreeWorld());
  world.boats[0].speed = 10;
  world.boats[0].throttle = 1;
  predictLocalWorld(world, 0, {}, 0.05);
  assert.equal(world.boats[0].throttle, 0);
  assert.ok(world.boats[0].speed > 9.98);
});

test("the automatic crate grants the requested one hundred rounds", () => {
  const world = createFreeWorld();
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "automatic");
  const initialAmmo = world.players[0].combat.ammo;
  let spoken = "";
  assert.equal(grantWeaponFromCrate(world, crate, 0, (_world, _type, text) => { spoken = text; }), true);
  assert.equal(world.players[0].combat.ammo, initialAmmo + 100);
  assert.match(spoken, /100/);
});

test("server-side pursuer gunfire stays finite and sends render-only projectiles", () => {
  const serverRoom = createServerFreeRoom(5_000);
  setServerFreePresence(serverRoom, "captain", true);
  setServerFreePresence(serverRoom, "crew", true);
  serverRoom.world.freeScenario.phase = "pursuit";
  serverRoom.world.freeScenario.announced = true;
  serverRoom.world.freeActivities.marauder.active = true;
  activatePursuerSquad(serverRoom.world);
  let now = serverRoom.lastTickAt;
  let maximumProjectiles = 0;
  let maximumBytes = 0;
  let maximumSixTickDeltaBytes = 0;
  let gunshotEvents = 0;
  let acknowledgedWorld = replicatedFreeWorld(serverRoom.world);

  for (let index = 0; index < 500; index += 1) {
    now += 40;
    const state = tickServerFreeRoom(serverRoom, now);
    maximumProjectiles = Math.max(
      maximumProjectiles,
      state.world.freePursuerSquad.projectiles.length + state.world.freeHostileGunners.projectiles.length,
    );
    maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(state)));
    if (index % 6 === 5) {
      maximumSixTickDeltaBytes = Math.max(
        maximumSixTickDeltaBytes,
        Buffer.byteLength(JSON.stringify(diffReplicatedWorld(acknowledgedWorld, state.world))),
      );
      acknowledgedWorld = state.world;
    }
    gunshotEvents += state.events.filter(event => ["pursuer-shot", "enemy-gun-shot"].includes(event.type)).length;
    for (const projectile of state.world.freePursuerSquad.projectiles) {
      assert.deepEqual(Object.keys(projectile).sort(), ["id", "x", "y"]);
    }
  }

  assert.ok(maximumProjectiles > 0, "the stress run should include physical bullets");
  assert.ok(gunshotEvents > 0, "the stress run should include audible gunfire events");
  assert.ok(maximumProjectiles <= 36);
  assert.ok(maximumBytes < 12_000, `combat state grew unexpectedly: ${maximumBytes} bytes`);
  assert.ok(maximumSixTickDeltaBytes < 6_000, `combat delta grew unexpectedly: ${maximumSixTickDeltaBytes} bytes`);
  assert.doesNotThrow(() => JSON.stringify(serverRoom.world));
});
