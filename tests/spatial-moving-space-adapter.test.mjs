import test from "node:test";
import assert from "node:assert/strict";

import {compileSpatialLocation, createSpatialModuleRegistry} from "../public/src/spatial/spatial-compiler.js";
import {createSpatialRuntime} from "../public/src/spatial/spatial-runtime.js";
import {
  applyMovingSpaceSample,
  createSpatialMovingSpaceAdapter,
} from "../public/src/spatial/spatial-moving-space-adapter.js";
import {transformPoint} from "../public/src/spatial/spatial-transform.js";

const rectangle = (width, height, maxZ = 3) => ({
  outer: [[0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]],
  minZ: 0,
  maxZ,
});

function createCarrierRuntime() {
  const definition = {
    schemaVersion: 1,
    id: "location.moving.test",
    label: "Moving-space test",
    presentation: {label: "Moving-space test", role: "location"},
    worldTransform: {position: {x: 100, y: 50, z: 2}, yaw: 30},
    spaces: [
      {
        id: "space.harbor",
        label: "Harbor",
        presentation: {label: "Harbor", role: "outdoor"},
        transform: {position: {x: 0, y: 0, z: 0}, yaw: 0},
        shape: rectangle(500, 500, 20),
        anchors: [{id: "anchor.harbor", kind: "spawn", label: "Harbor spawn", position: [10, 10, 0]}],
        objects: [],
      },
      {
        id: "space.ship",
        label: "Ship",
        presentation: {label: "Ship", role: "vehicle"},
        moving: true,
        transform: {position: {x: 20, y: 20, z: 0}, yaw: 0},
        shape: rectangle(20, 10, 6),
        anchors: [{id: "anchor.ship", kind: "spawn", label: "Ship deck", position: [2, 2, 0]}],
        objects: [],
      },
      {
        id: "space.cabin",
        label: "Cabin",
        presentation: {label: "Cabin", role: "indoor"},
        parentSpaceId: "space.ship",
        transform: {position: {x: 6, y: 2, z: 1}, yaw: 15},
        shape: rectangle(6, 5, 3),
        anchors: [{id: "anchor.cabin", kind: "spawn", label: "Cabin spawn", position: [1, 1, 0]}],
        objects: [],
      },
      {
        id: "space.platform",
        label: "Moving platform",
        presentation: {label: "Moving platform", role: "vehicle"},
        parentSpaceId: "space.harbor",
        moving: true,
        transform: {position: {x: 30, y: 30, z: 0}, yaw: 0},
        shape: rectangle(8, 8, 3),
        anchors: [{id: "anchor.platform", kind: "spawn", label: "Platform spawn", position: [1, 1, 0]}],
        objects: [],
      },
    ],
    connections: [],
    spawns: [
      {id: "spawn.ship", spaceId: "space.ship", anchorId: "anchor.ship", mode: "foot"},
      {id: "spawn.cabin", spaceId: "space.cabin", anchorId: "anchor.cabin", mode: "foot"},
      {id: "spawn.platform", spaceId: "space.platform", anchorId: "anchor.platform", mode: "foot"},
    ],
    modules: [],
  };
  const compiled = compileSpatialLocation(definition, {moduleRegistry: createSpatialModuleRegistry()});
  return createSpatialRuntime(compiled);
}

function roundedTransform(transform) {
  return {
    position: {
      x: Math.round(transform.position.x * 1e6) / 1e6,
      y: Math.round(transform.position.y * 1e6) / 1e6,
      z: Math.round(transform.position.z * 1e6) / 1e6,
    },
    yaw: Math.round(transform.yaw * 1e6) / 1e6,
  };
}

test("a ship-like moving top-level space can follow an external world transform without owning vessel physics", () => {
  const runtime = createCarrierRuntime();
  const carrier = {x: 220, y: 140, z: 1.5, yaw: 75, speed: 18};
  const before = structuredClone(carrier);
  const adapter = createSpatialMovingSpaceAdapter({
    readTransform({carrier}) {
      return {
        coordinates: "world",
        position: {x: carrier.x, y: carrier.y, z: carrier.z},
        yaw: carrier.yaw,
      };
    },
  });

  const result = adapter.sync(runtime, "space.ship", {carrier});

  assert.equal(result.changed, true);
  assert.deepEqual(roundedTransform(result.worldTransform), {
    position: {x: 220, y: 140, z: 1.5},
    yaw: 75,
  });
  assert.deepEqual(carrier, before, "moving-space adapter must read carrier state without advancing speed or physics");
});

test("a moving platform nested under a parent resolves a requested world transform through the shared transform core", () => {
  const runtime = createCarrierRuntime();
  const result = applyMovingSpaceSample(runtime, "space.platform", {
    coordinates: "world",
    position: {x: 160, y: 120, z: 5},
    yaw: -20,
  });

  assert.deepEqual(roundedTransform(result.worldTransform), {
    position: {x: 160, y: 120, z: 5},
    yaw: -20,
  });
  assert.notDeepEqual(roundedTransform(result.localTransform), roundedTransform(result.worldTransform), "adapter must convert world motion into the parent's local coordinates instead of copying it twice");
});

test("an entity in a nested cabin follows its moving ship while keeping exactly the same local coordinates", () => {
  const runtime = createCarrierRuntime();
  runtime.spawnEntity({id: "object.nested", kind: "actor", spawnId: "spawn.cabin"});
  const localBefore = runtime.getEntity("object.nested").localPosition;
  const worldBefore = runtime.getEntityWorldPosition("object.nested");

  applyMovingSpaceSample(runtime, "space.ship", {
    coordinates: "world",
    position: {x: 250, y: 180, z: 4},
    yaw: 100,
  });

  const localAfter = runtime.getEntity("object.nested").localPosition;
  const worldAfter = runtime.getEntityWorldPosition("object.nested");
  assert.deepEqual(localAfter, localBefore);
  assert.notDeepEqual(worldAfter, worldBefore);
  const cabinWorld = runtime.getSpaceWorldTransform("space.cabin");
  assert.deepEqual(worldAfter, transformPoint(cabinWorld, localAfter));
});

test("repeating the same carrier transform does not emit a second space transform event", () => {
  const runtime = createCarrierRuntime();
  const sample = {coordinates: "world", position: {x: 220, y: 140, z: 1}, yaw: 35};
  assert.equal(applyMovingSpaceSample(runtime, "space.ship", sample).changed, true);
  const before = runtime.events.filter(event => event.kind === "space.transform").length;
  assert.equal(applyMovingSpaceSample(runtime, "space.ship", sample).changed, false);
  const after = runtime.events.filter(event => event.kind === "space.transform").length;
  assert.equal(after, before);
});

test("adapter refuses to move a static space instead of creating a second hidden transform authority", () => {
  const runtime = createCarrierRuntime();
  assert.throws(() => applyMovingSpaceSample(runtime, "space.harbor", {
    coordinates: "world",
    position: {x: 0, y: 0, z: 0},
    yaw: 0,
  }), /not declared moving/);
});
