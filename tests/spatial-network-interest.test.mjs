import test from "node:test";
import assert from "node:assert/strict";

import {createSpatialLab} from "../public/src/locations/spatial-lab/location.js";
import {collectSpatialInterestSpaceIds} from "../public/src/spatial/spatial-interest.js";

test("two viewers receive independent selective replication instead of inheriting the other player's preloaded spaces", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.spawnEntity({id: "player.two", spawnId: "lab.spawn.store"});
  runtime.refreshActivity();
  const replication = runtime.getModule("lab.replication");

  const one = replication.snapshot("player.one");
  const two = replication.snapshot("player.two");

  assert.ok(one.spaces.includes("lab.yard"));
  assert.ok(!one.spaces.includes("lab.remote.store"));
  assert.ok(two.spaces.includes("lab.remote.store"));
  assert.ok(!two.spaces.includes("lab.yard"));
  assert.ok(!two.spaces.includes("lab.lift"), "viewer two must not inherit a lift preloaded only because viewer one is nearby");
  assert.ok(one.entities.some(entity => entity.id === "player.one"));
  assert.ok(!one.entities.some(entity => entity.id === "player.two"));
  assert.ok(two.entities.some(entity => entity.id === "player.two"));
  assert.ok(!two.entities.some(entity => entity.id === "player.one"));
  assert.equal(runtime.listEntities().filter(entity => entity.kind === "player").length, 2, "the authoritative server still owns both players");
});

test("remote spatial events are filtered from the other viewer's replication snapshot", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.spawnEntity({id: "player.two", spawnId: "lab.spawn.store"});
  runtime.moveEntity("player.two", {x: 4, y: 4, z: 0});
  const snapshot = runtime.getModule("lab.replication").snapshot("player.one");
  assert.deepEqual(snapshot.events.filter(event => event.entityId === "player.two"), []);
  assert.ok(snapshot.events.some(event => event.entityId === "player.one"));
});

test("sleep and wake stay global server lifecycle decisions while network interest stays viewer-local", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "sleeping");

  runtime.spawnEntity({id: "player.two", spawnId: "lab.spawn.store"});
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "active");
  const read = {
    location: runtime.location,
    getEntity: id => runtime.getEntity(id),
  };
  assert.ok(!collectSpatialInterestSpaceIds(read, "player.one").includes("lab.remote.store"));

  runtime.removeEntity("player.two");
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "sleeping");
});
