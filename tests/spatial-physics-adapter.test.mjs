import test from "node:test";
import assert from "node:assert/strict";

import {
  applyVerticalPhysicsSample,
  createSpatialVerticalPhysicsAdapter,
  normalizeVerticalPhysicsSample,
} from "../public/src/spatial/spatial-physics-adapter.js";
import {createSpatialLab} from "../public/src/locations/spatial-lab/location.js";

test("vertical physics sample combines support height and externally calculated offset without advancing physics", () => {
  const sample = normalizeVerticalPhysicsSample({
    supportLocalZ: 0.5,
    offsetZ: 1.25,
    velocityZ: -2.4,
    airborne: true,
  });
  assert.deepEqual(sample, {
    supportLocalZ: 0.5,
    offsetZ: 1.25,
    localZ: 1.75,
    velocityZ: -2.4,
    airborne: true,
  });
});

test("adapter changes only local z and leaves x/y under the existing movement authority", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.moveEntity("player.one", {x: 4, y: 5, z: 0});
  const before = runtime.getEntity("player.one");

  const result = applyVerticalPhysicsSample(runtime, "player.one", {
    supportLocalZ: 0,
    offsetZ: 1.2,
    velocityZ: 3.1,
    airborne: true,
  });

  assert.equal(result.changed, true);
  assert.equal(result.entity.localPosition.x, before.localPosition.x);
  assert.equal(result.entity.localPosition.y, before.localPosition.y);
  assert.equal(result.entity.localPosition.z, 1.2);
  assert.equal(Math.round(result.worldPosition.z * 1000) / 1000, 3.2);
});

test("unchanged height does not create a second spatial movement event", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  const first = applyVerticalPhysicsSample(runtime, "player.one", {supportLocalZ: 0, offsetZ: 1});
  assert.equal(first.changed, true);
  const moveEventsBefore = runtime.events.filter(event => event.kind === "entity.move").length;

  const second = applyVerticalPhysicsSample(runtime, "player.one", {supportLocalZ: 0.25, offsetZ: 0.75});
  const moveEventsAfter = runtime.events.filter(event => event.kind === "entity.move").length;

  assert.equal(second.changed, false);
  assert.equal(moveEventsAfter, moveEventsBefore);
});

test("legacy jump state remains authoritative and is only read by the adapter", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  const legacyPlayer = {
    jumpHeight: 1.35,
    jumpVelocity: 2.75,
    airborne: true,
  };
  const before = structuredClone(legacyPlayer);
  const adapter = createSpatialVerticalPhysicsAdapter({
    readSample({player, floorLocalZ}) {
      return {
        supportLocalZ: floorLocalZ,
        offsetZ: player.jumpHeight,
        velocityZ: player.jumpVelocity,
        airborne: player.airborne,
      };
    },
  });

  const result = adapter.sync(runtime, "player.one", {player: legacyPlayer, floorLocalZ: 0});

  assert.equal(result.entity.localPosition.z, 1.35);
  assert.deepEqual(legacyPlayer, before, "the adapter must not advance jump height, velocity or airborne state");
});

test("true elevation composes with higher and moving nested spaces instead of duplicating their transforms", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.upper"});
  let result = applyVerticalPhysicsSample(runtime, "player.one", {supportLocalZ: 0, offsetZ: 1});
  assert.equal(Math.round(result.worldPosition.z * 1000) / 1000, 7);

  runtime.removeEntity("player.one");
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.transitionEntity("player.one", "lab.connection.lift.board");
  result = applyVerticalPhysicsSample(runtime, "player.one", {supportLocalZ: 0, offsetZ: 0.7});
  assert.equal(Math.round(result.worldPosition.z * 1000) / 1000, 2.7);

  runtime.setSpaceTransform("lab.lift", {position: {x: 5, y: 5, z: 4}, yaw: 0});
  const movedWorld = runtime.getEntityWorldPosition("player.one");
  assert.equal(Math.round(movedWorld.z * 1000) / 1000, 6.7);
  assert.equal(runtime.getEntity("player.one").localPosition.z, 0.7);
});

test("adapter delegates vertical safety to the existing spatial bounds instead of silently clamping height", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  const before = runtime.getEntity("player.one");

  assert.throws(() => applyVerticalPhysicsSample(runtime, "player.one", {
    supportLocalZ: 0,
    offsetZ: 99,
    velocityZ: 5,
    airborne: true,
  }), /outside space/);

  assert.deepEqual(runtime.getEntity("player.one").localPosition, before.localPosition);
});
