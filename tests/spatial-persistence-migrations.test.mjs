import test from "node:test";
import assert from "node:assert/strict";

import {compileSpatialLocation, createSpatialModuleRegistry} from "../public/src/spatial/spatial-compiler.js";
import {createSpatialRuntime, SpatialRuntimeError} from "../public/src/spatial/spatial-runtime.js";

function rectangle(width = 10, height = 10) {
  return {outer: [[0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]], minZ: 0, maxZ: 3};
}

function locationDefinition({persistenceVersion = 1, modules = []} = {}) {
  return {
    schemaVersion: 1,
    id: "location.persistence.test",
    label: "Тест сохранений",
    presentation: {label: "Тест сохранений", role: "location"},
    persistence: {version: persistenceVersion},
    spaces: [{
      id: "space.room",
      label: "Комната",
      presentation: {label: "Комната", role: "indoor"},
      shape: rectangle(),
      anchors: [{id: "anchor.safe", kind: "spawn", label: "Безопасная точка", position: [2, 2, 0]}],
      objects: [],
    }],
    connections: [],
    spawns: [{id: "spawn.safe", spaceId: "space.room", anchorId: "anchor.safe", mode: "foot"}],
    modules,
  };
}

function runtimeFor({persistenceVersion = 1, moduleTypes = [], modules = []} = {}) {
  const registry = createSpatialModuleRegistry(moduleTypes);
  const compiled = compileSpatialLocation(locationDefinition({persistenceVersion, modules}), {moduleRegistry: registry});
  return createSpatialRuntime(compiled, {clock: (() => { let value = 1000; return () => ++value; })()});
}

test("location persistence migrations advance independently from the save format", () => {
  const runtime = runtimeFor({persistenceVersion: 2});
  runtime.spawnEntity({id: "player.one", spawnId: "spawn.safe", data: {legacyScore: 7}});
  const old = structuredClone(runtime.saveState());
  old.persistenceVersion = 1;
  old.entities[0].data = {legacyScore: 9};

  runtime.moveEntity("player.one", {x: 5, y: 5, z: 0});
  runtime.restoreState(old, {
    persistenceMigrations: [{
      from: 1,
      to: 2,
      run(snapshot, context) {
        assert.equal(context.locationId, "location.persistence.test");
        snapshot.entities[0].data = {score: snapshot.entities[0].data.legacyScore};
        delete snapshot.entities[0].data.legacyScore;
        return snapshot;
      },
    }],
  });

  assert.deepEqual(runtime.getEntity("player.one").data, {score: 9});
  assert.equal(runtime.saveState().persistenceVersion, 2);
});

test("missing or future persistence versions fail before mutating the live world", () => {
  const runtime = runtimeFor({persistenceVersion: 2});
  runtime.spawnEntity({id: "player.one", spawnId: "spawn.safe"});
  runtime.moveEntity("player.one", {x: 6, y: 6, z: 0});
  const before = runtime.saveState();

  const old = structuredClone(before);
  old.persistenceVersion = 1;
  old.entities[0].localPosition = {x: 3, y: 3, z: 0};
  assert.throws(() => runtime.restoreState(old), /missing location persistence migration 1 to 2/);
  assert.deepEqual(runtime.getEntity("player.one").localPosition, before.entities[0].localPosition);

  const future = structuredClone(before);
  future.persistenceVersion = 3;
  assert.throws(() => runtime.restoreState(future), /unsupported location persistence version 3/);
  assert.deepEqual(runtime.getEntity("player.one").localPosition, before.entities[0].localPosition);
});

test("failed module restore rolls back earlier modules, world state, revision and emitted events", () => {
  const moduleTypes = [
    {
      id: "test.state.one",
      create(context) {
        let value = 10;
        return {
          serialize() { return {value}; },
          restore(state) {
            value = Number(state.value);
            context.emit("test.module.restore", {value});
          },
          value() { return value; },
        };
      },
    },
    {
      id: "test.state.two",
      create(context) {
        let value = 20;
        return {
          serialize() { return {value}; },
          restore(state) {
            value = Number(state.value);
            context.emit("test.module.restore", {value});
            if (state.fail === true) throw new Error("planned module failure");
          },
          value() { return value; },
        };
      },
    },
  ];
  const modules = [
    {id: "module.one", type: "test.state.one", config: {}},
    {id: "module.two", type: "test.state.two", config: {}},
  ];
  const runtime = runtimeFor({moduleTypes, modules});
  runtime.spawnEntity({id: "player.one", spawnId: "spawn.safe"});
  runtime.moveEntity("player.one", {x: 6, y: 6, z: 0});
  const before = runtime.saveState();
  const revisionBefore = runtime.revision;
  const observed = [];
  runtime.subscribe(event => observed.push(event));

  const incoming = structuredClone(before);
  incoming.revision = 90;
  incoming.entities[0].localPosition = {x: 3, y: 3, z: 0};
  incoming.moduleState["module.one"] = {value: 111};
  incoming.moduleState["module.two"] = {value: 222, fail: true};

  assert.throws(() => runtime.restoreState(incoming), /restore failed transactionally: planned module failure/);
  assert.equal(runtime.getModule("module.one").value(), 10);
  assert.equal(runtime.getModule("module.two").value(), 20);
  assert.deepEqual(runtime.getEntity("player.one").localPosition, before.entities[0].localPosition);
  assert.equal(runtime.revision, revisionBefore);
  assert.deepEqual(observed, [], "events from a failed restore must never reach listeners");
  assert.equal(runtime.events.some(event => event.kind === "test.module.restore"), false);
});

test("successful module restore releases buffered events only after the transaction commits", () => {
  const moduleTypes = [{
    id: "test.state.ok",
    create(context) {
      let value = 1;
      return {
        serialize() { return {value}; },
        restore(state) {
          value = Number(state.value);
          context.emit("test.module.restore", {value});
        },
        value() { return value; },
      };
    },
  }];
  const runtime = runtimeFor({
    moduleTypes,
    modules: [{id: "module.ok", type: "test.state.ok", config: {}}],
  });
  runtime.spawnEntity({id: "player.one", spawnId: "spawn.safe"});
  const incoming = structuredClone(runtime.saveState());
  incoming.moduleState["module.ok"] = {value: 5};
  const observed = [];
  runtime.subscribe(event => observed.push(event.kind));

  runtime.restoreState(incoming);

  assert.equal(runtime.getModule("module.ok").value(), 5);
  assert.deepEqual(observed, ["test.module.restore", "world.restore"]);
});

import {SpatialWorld} from "../public/src/spatial/spatial-world.js";

function worldLocation(id, {persistenceVersion = 1, modules = []} = {}) {
  return {
    ...locationDefinition({persistenceVersion, modules}),
    id,
    label: id,
    presentation: {label: id, role: "location"},
  };
}

test("SpatialWorld forwards persistence migrations to the matching location", () => {
  const world = new SpatialWorld({moduleRegistry: createSpatialModuleRegistry()});
  const runtime = world.addLocation(worldLocation("location.world.migration", {persistenceVersion: 2}));
  runtime.spawnEntity({id: "player.one", spawnId: "spawn.safe", data: {legacyScore: 4}});
  const snapshot = structuredClone(world.saveWorld());
  snapshot.locations["location.world.migration"].persistenceVersion = 1;
  snapshot.locations["location.world.migration"].entities[0].data = {legacyScore: 12};

  world.restoreWorld(snapshot, {
    restoreOptionsByLocation: {
      "location.world.migration": {
        persistenceMigrations: [{
          from: 1,
          to: 2,
          run(state) {
            state.entities[0].data = {score: state.entities[0].data.legacyScore};
            return state;
          },
        }],
      },
    },
  });

  assert.deepEqual(runtime.getEntity("player.one").data, {score: 12});
});

test("failed multi-location restore rolls live state and SpatialWorld event stream back", () => {
  const statefulType = {
    id: "test.world.state",
    create(context) {
      let value = Number(context.config.initial) || 0;
      return {
        serialize() { return {value}; },
        restore(state) {
          value = Number(state.value);
          context.emit("test.world.module.restore", {value});
          if (state.fail === true) throw new Error("planned world restore failure");
        },
        value() { return value; },
      };
    },
  };
  const registry = createSpatialModuleRegistry([statefulType]);
  const world = new SpatialWorld({moduleRegistry: registry, clock: (() => { let value = 2000; return () => ++value; })()});
  const first = world.addLocation(worldLocation("location.world.first", {
    modules: [{id: "module.first", type: "test.world.state", config: {initial: 10}}],
  }));
  const second = world.addLocation(worldLocation("location.world.second", {
    modules: [{id: "module.second", type: "test.world.state", config: {initial: 20}}],
  }));
  first.spawnEntity({id: "player.first", spawnId: "spawn.safe"});
  second.spawnEntity({id: "player.second", spawnId: "spawn.safe"});
  const snapshot = structuredClone(world.saveWorld());
  snapshot.locations["location.world.first"].moduleState["module.first"] = {value: 111};
  snapshot.locations["location.world.second"].moduleState["module.second"] = {value: 222, fail: true};
  const eventsBefore = structuredClone(world.events);
  const revisionBefore = world.revision;
  const firstEventsBefore = structuredClone(first.events);
  const secondEventsBefore = structuredClone(second.events);
  const firstRevisionBefore = first.revision;
  const secondRevisionBefore = second.revision;

  assert.throws(() => world.restoreWorld(snapshot), /world restore rolled back: restore failed transactionally: planned world restore failure/);

  assert.equal(first.getModule("module.first").value(), 10);
  assert.equal(second.getModule("module.second").value(), 20);
  assert.equal(first.revision, firstRevisionBefore);
  assert.equal(second.revision, secondRevisionBefore);
  assert.deepEqual(first.events, firstEventsBefore, "a location restored before a later failure must not keep phantom local events");
  assert.deepEqual(second.events, secondEventsBefore, "the failing location must not keep restore events either");
  assert.equal(world.revision, revisionBefore);
  assert.deepEqual(world.events, eventsBefore, "failed world restore must not publish an impossible intermediate event stream");
});
