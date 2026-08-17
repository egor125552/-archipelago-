import test from "node:test";
import assert from "node:assert/strict";

import {
  SPATIAL_ACTOR_SCHEMA_VERSION,
  createSpatialActorState,
  normalizeSpatialActorConfig,
  normalizeSpatialActorDefinition,
  spatialActorEntityId,
} from "../public/src/spatial/spatial-actor-contract.js";
import {createSpatialActorService} from "../public/src/spatial/spatial-actor-module.js";

test("actor contract normalizes one stable spatial actor definition", () => {
  const actor = normalizeSpatialActorDefinition({
    id: "guard.one",
    label: "Охранник",
    kind: "guard",
    spaceId: "room.one",
    position: [2, 3, 1],
    maxHealth: 75,
    hostile: true,
    tags: ["human", "armed"],
    data: {faction: "lab"},
  });
  assert.equal(actor.schemaVersion, SPATIAL_ACTOR_SCHEMA_VERSION);
  assert.equal(actor.id, "guard.one");
  assert.equal(actor.spaceId, "room.one");
  assert.deepEqual(actor.position, {x: 2, y: 3, z: 1});
  assert.equal(actor.maxHealth, 75);
  assert.equal(actor.hostile, true);
  assert.deepEqual(actor.tags, ["human", "armed"]);
  assert.equal(spatialActorEntityId(actor.id), "actor.guard.one");
});

test("actor contract rejects duplicate stable ids and invalid coordinates", () => {
  assert.throws(() => normalizeSpatialActorConfig({actors: [
    {id: "same", spaceId: "a"},
    {id: "same", spaceId: "b"},
  ]}), /duplicate actor id/);
  assert.throws(() => normalizeSpatialActorDefinition({id: "bad", spaceId: "a", position: [Infinity, 0, 0]}), /must be finite/);
});

test("actor state contract clamps restored health and derives alive consistently", () => {
  const definition = normalizeSpatialActorDefinition({id: "dummy", spaceId: "room", maxHealth: 80});
  assert.deepEqual(createSpatialActorState(definition), {health: 80, alive: true, spawned: false});
  assert.deepEqual(createSpatialActorState(definition, {health: 200, alive: true, spawned: true}), {health: 80, alive: true, spawned: true});
  assert.deepEqual(createSpatialActorState(definition, {health: 0, alive: true}), {health: 0, alive: false, spawned: false});
});

test("actor service is built on the shared actor contract instead of a second schema", () => {
  const service = createSpatialActorService({actors: [{id: "dummy", spaceId: "room", position: [1, 2, 0], maxHealth: 20}]});
  const actor = service.get("dummy");
  assert.equal(actor.schemaVersion, SPATIAL_ACTOR_SCHEMA_VERSION);
  assert.equal(actor.entityId, "actor.dummy");
  assert.deepEqual(actor.position, {x: 1, y: 2, z: 0});
});
