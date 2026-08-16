import test from "node:test";
import assert from "node:assert/strict";

import {
  SpatialCompileError,
  compileSpatialLocation,
  createSpatialModuleRegistry,
} from "../public/src/spatial/spatial-compiler.js";
import {createSpatialRuntime} from "../public/src/spatial/spatial-runtime.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "../public/src/spatial/spatial-standard-modules.js";
import {SPATIAL_LAB_LOCATION, createSpatialLab} from "../public/src/locations/spatial-lab/location.js";

const clone = value => JSON.parse(JSON.stringify(value));

function standardRegistry(extra = []) {
  return createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, ...extra]);
}

test("spatial lab compiles as an isolated config and rejects broken references", () => {
  const {compiled, runtime} = createSpatialLab();
  assert.equal(compiled.id, "location.spatial.lab");
  assert.equal(compiled.spaces.length, 4);
  assert.equal(compiled.modules.length, 6);
  assert.equal(runtime.getDiagnostics().length, 0);
  for (const id of ["lab.navigation", "lab.acoustics", "lab.accessibility", "lab.lifecycle", "lab.replication", "lab.persistence"]) {
    assert.ok(runtime.getModule(id), `${id} must be active`);
  }

  const broken = clone(SPATIAL_LAB_LOCATION);
  broken.connections[0].to.spaceId = "lab.missing.space";
  assert.throws(() => compileSpatialLocation(broken, {moduleRegistry: standardRegistry()}), SpatialCompileError);

  const duplicate = clone(SPATIAL_LAB_LOCATION);
  duplicate.spaces.push(clone(duplicate.spaces[0]));
  assert.throws(() => compileSpatialLocation(duplicate, {moduleRegistry: standardRegistry()}), SpatialCompileError);
});

test("height, safe transitions and moving nested spaces preserve local coordinates", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  assert.equal(runtime.getEntityWorldPosition("player.one").z, 2);

  runtime.transitionEntity("player.one", "lab.connection.stairs");
  assert.equal(runtime.getEntity("player.one").spaceId, "lab.upper.room");
  assert.equal(runtime.getEntityWorldPosition("player.one").z, 6);

  assert.throws(() => runtime.moveEntity("player.one", {x: 50, y: 50, z: 0}), /outside space/);

  runtime.removeEntity("player.one");
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.transitionEntity("player.one", "lab.connection.lift.board");
  const before = runtime.getEntityWorldPosition("player.one");
  runtime.setSpaceTransform("lab.lift", {position: {x: 5, y: 5, z: 4}, yaw: 0});
  const after = runtime.getEntityWorldPosition("player.one");
  assert.equal(Math.round((after.z - before.z) * 1000) / 1000, 4);
  assert.deepEqual(runtime.getEntity("player.one").localPosition, {x: 1.5, y: 1.5, z: 0});

  assert.throws(() => runtime.transitionEntity("player.one", "lab.connection.lift.exit"), /not passable/);
  runtime.setConnectionState("lab.connection.lift.exit", "open");
  runtime.transitionEntity("player.one", "lab.connection.lift.exit");
  assert.equal(runtime.getEntity("player.one").spaceId, "lab.upper.room");
});

test("navigation, accessibility semantics and acoustics use the same live connection state", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});

  const navigation = runtime.getModule("lab.navigation");
  const route = navigation.findRoute({fromSpaceId: "lab.yard", toSpaceId: "lab.remote.store"});
  assert.deepEqual(route.spaces, ["lab.yard", "lab.upper.room", "lab.remote.store"]);
  assert.match(navigation.describeRoute(route), /Лестница наверх/);
  assert.match(navigation.describeRoute(route), /Удалённый склад/);

  const accessibility = runtime.getModule("lab.accessibility");
  const context = accessibility.describe("player.one");
  assert.equal(context.space.label, "Испытательный двор");
  assert.equal(context.elevation, 2);
  assert.ok(context.landmarks.some(entry => entry.label === "Вход во двор"));
  assert.ok(context.transitions.some(entry => entry.label === "Лестница наверх" && entry.available));

  const acoustics = runtime.getModule("lab.acoustics");
  const open = acoustics.compute({sourceSpaceId: "lab.yard", listenerSpaceId: "lab.upper.room"});
  runtime.setConnectionState("lab.connection.stairs", "closed");
  const closed = acoustics.compute({sourceSpaceId: "lab.yard", listenerSpaceId: "lab.upper.room"});
  assert.ok(closed.gain < open.gain);
  assert.ok(closed.lowpassHz < open.lowpassHz);

  assert.equal(navigation.findRoute({fromSpaceId: "lab.yard", toSpaceId: "lab.remote.store"}), null);
  runtime.setConnectionState("lab.connection.lift.exit", "open");
  const alternate = navigation.findRoute({fromSpaceId: "lab.yard", toSpaceId: "lab.remote.store"});
  assert.deepEqual(alternate.spaces, ["lab.yard", "lab.lift", "lab.upper.room", "lab.remote.store"]);
});

test("complete state restores transactionally and broken entity references recover to a safe spawn", () => {
  let tick = 1000;
  const {runtime} = createSpatialLab({clock: () => ++tick});
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry", data: {score: 7}});
  runtime.spawnEntity({id: "player.two", spawnId: "lab.spawn.store"});
  runtime.setConnectionState("lab.connection.lift.exit", "open");
  runtime.setSpaceTransform("lab.lift", {position: {x: 5, y: 5, z: 4}, yaw: 12});

  const saved = runtime.saveState();
  runtime.removeEntity("player.two");
  runtime.setConnectionState("lab.connection.lift.exit", "closed");
  runtime.setSpaceTransform("lab.lift", {position: {x: 2, y: 2, z: 0}, yaw: 0});
  runtime.restoreState(saved);

  assert.equal(runtime.getEntity("player.two").spaceId, "lab.remote.store");
  assert.equal(runtime.getConnectionState("lab.connection.lift.exit"), "open");
  assert.equal(runtime.getSpaceWorldTransform("lab.lift").position.z, 6);

  const damaged = clone(saved);
  damaged.entities[0].spaceId = "deleted.space";
  damaged.entities[0].localPosition = {x: 999, y: 999, z: 999};
  runtime.restoreState(damaged);
  assert.equal(runtime.getEntity("player.one").spaceId, "lab.yard");
  assert.deepEqual(runtime.getEntity("player.one").localPosition, {x: 2, y: 2, z: 0});
  assert.ok(runtime.getDiagnostics().some(entry => entry.code === "spatial.save.entity-recovered"));
});

test("two players share one authoritative world while sleep/wake and replication stay local", () => {
  const {runtime} = createSpatialLab();
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "sleeping");

  runtime.spawnEntity({id: "player.two", spawnId: "lab.spawn.store"});
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "active");

  const replication = runtime.getModule("lab.replication");
  const nearOne = replication.snapshot("player.one");
  const nearTwo = replication.snapshot("player.two");
  assert.ok(nearOne.entities.some(entity => entity.id === "player.one"));
  assert.ok(!nearOne.entities.some(entity => entity.id === "player.two"));
  assert.ok(nearTwo.entities.some(entity => entity.id === "player.two"));
  assert.ok(!nearTwo.entities.some(entity => entity.id === "player.one"));
  assert.equal(runtime.listEntities().length, 2, "server still owns both players in one world");

  runtime.removeEntity("player.two");
  runtime.refreshActivity();
  assert.equal(runtime.getSpaceActivity("lab.remote.store"), "sleeping");
});

test("an optional location module can fail without taking down the location", () => {
  const definition = clone(SPATIAL_LAB_LOCATION);
  definition.modules.push({id: "lab.optional.failure", type: "lab.failure.module", optional: true, config: {}});
  definition.compatibility = [{
    code: "compat.lab.synthetic",
    legacySystem: "legacy.synthetic",
    replacement: "spatial.runtime",
    targetId: "lab.optional.failure",
    message: "Synthetic acceptance warning for compatibility diagnostics",
  }];

  const failingType = {
    id: "lab.failure.module",
    create(context) {
      assert.equal(context.restore, undefined, "unprivileged module must not receive persistence mutation access");
      assert.equal(context.refreshActivity, undefined, "unprivileged module must not receive lifecycle mutation access");
      throw new Error("expected isolated failure");
    },
  };
  const compiled = compileSpatialLocation(definition, {moduleRegistry: standardRegistry([failingType]), mode: "production"});
  const runtime = createSpatialRuntime(compiled);
  runtime.spawnEntity({id: "player.one", spawnId: "lab.spawn.entry"});

  assert.equal(runtime.getDisabledModuleReason("lab.optional.failure"), "startup-failed");
  assert.ok(runtime.getDiagnostics().some(entry => entry.code === "spatial.module.optional-runtime-failure"));
  assert.ok(runtime.getDiagnostics().some(entry => entry.code === "compat.lab.synthetic" && entry.kind === "compatibility"));
  assert.equal(runtime.getEntity("player.one").spaceId, "lab.yard");
  assert.ok(runtime.getModule("lab.navigation").findRoute({fromSpaceId: "lab.yard", toSpaceId: "lab.upper.room"}));
});

test("world registry transfers one entity between modular locations and isolates an optional broken location", async () => {
  const {SpatialWorld} = await import("../public/src/spatial/spatial-world.js");
  const world = new SpatialWorld({moduleRegistry: standardRegistry(), mode: "production"});
  const first = clone(SPATIAL_LAB_LOCATION);
  const second = clone(SPATIAL_LAB_LOCATION);
  second.id = "location.spatial.lab.two";
  second.label = "Вторая пространственная лаборатория";
  second.presentation.label = second.label;
  second.worldTransform.position.x = 400;

  world.addLocation(first);
  world.addLocation(second);
  world.spawnEntity(first.id, {id: "player.world", label: "Мировой игрок", spawnId: "lab.spawn.entry", data: {score: 12}});
  world.registerLink({
    id: "world.link.lab",
    from: {locationId: first.id, spawnId: "lab.spawn.entry"},
    to: {locationId: second.id, spawnId: "lab.spawn.upper"},
  });
  world.useLink("player.world", "world.link.lab");
  const found = world.findEntity("player.world");
  assert.equal(found.locationId, second.id);
  assert.equal(found.entity.spaceId, "lab.upper.room");
  assert.equal(found.entity.data.score, 12);
  assert.equal(world.getLocationRuntime(first.id).getEntity("player.world"), null);

  const broken = clone(SPATIAL_LAB_LOCATION);
  broken.id = "location.broken.optional";
  broken.connections[0].to.spaceId = "missing.space";
  assert.equal(world.addLocation(broken, {optional: true}), null);
  assert.ok(world.getDiagnostics().some(entry => entry.code === "spatial.location.optional-disabled" && entry.locationId === broken.id));
});
