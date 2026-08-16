import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  initializeFreeRoamSpatialBridge,
  prepareFreeRoamSpatialInput,
  syncFreeRoamSpatialBridge,
} from "../public/src/spatial/spatial-free-roam-bridge.js";
import {SPATIAL_LAB_FREE_ROAM_BINDING} from "../public/src/locations/spatial-lab/free-roam-binding.js";

function worldAt(x, y) {
  return {
    time: 0,
    events: [],
    players: [{
      id: 0,
      mode: "foot",
      activeBoat: null,
      x,
      y,
      heading: 0,
      airborne: false,
      jumpHeight: 0,
      jumpVelocity: 0,
    }],
  };
}

function passage(id) {
  return SPATIAL_LAB_FREE_ROAM_BINDING.passages.find(entry => entry.id === id);
}

test("the spatial lab lives inside the existing shore walking bounds", () => {
  assert.equal(SPATIAL_LAB_FREE_ROAM_BINDING.id, "location.spatial.lab");
  for (const space of SPATIAL_LAB_FREE_ROAM_BINDING.spaces) {
    assert.ok(space.bounds.minX >= 118, `${space.id} minX`);
    assert.ok(space.bounds.maxX <= 302, `${space.id} maxX`);
    assert.ok(space.bounds.minY >= 8, `${space.id} minY`);
    assert.ok(space.bounds.maxY <= 76, `${space.id} maxY`);
  }
});

test("the existing action enters and exits the location without creating another movement input", () => {
  const gate = passage("world.passage.shore-to-spatial-lab");
  const world = worldAt(gate.from.position.x, gate.from.position.y);
  initializeFreeRoamSpatialBridge(world, SPATIAL_LAB_FREE_ROAM_BINDING);

  const prepared = prepareFreeRoamSpatialInput(world, 0, {action: true, up: true, run: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  const player = world.players[0];
  assert.equal(prepared.action, false, "the gate consumes only the ordinary action press");
  assert.equal(prepared.up, true);
  assert.equal(prepared.run, true);
  assert.equal(player.mode, "foot");
  assert.equal(player.spatialLocationId, SPATIAL_LAB_FREE_ROAM_BINDING.id);
  assert.equal(player.spatialSpaceId, "lab.yard");
  assert.equal(player.x, gate.to.position.x);
  assert.equal(player.y, gate.to.position.y);
  assert.equal(player.z, 2);
  assert.ok(world.events.some(event => event.type === "location-enter"));

  prepareFreeRoamSpatialInput(world, 0, {action: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.equal(player.spatialLocationId, SPATIAL_LAB_FREE_ROAM_BINDING.id, "holding action must not immediately throw the player back outside");

  prepareFreeRoamSpatialInput(world, 0, {action: false}, SPATIAL_LAB_FREE_ROAM_BINDING);
  prepareFreeRoamSpatialInput(world, 0, {action: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.equal(player.spatialLocationId, null);
  assert.equal(player.spatialSpaceId, null);
  assert.equal(player.x, gate.from.position.x);
  assert.equal(player.y, gate.from.position.y);
  assert.equal(player.z, 0);
  assert.ok(world.events.some(event => event.type === "location-exit"));
});

test("the shore entrance is accessible from the approach seen in the developer log", () => {
  const gate = passage("world.passage.shore-to-spatial-lab");
  assert.equal(gate.from.radius, 13);

  const world = worldAt(202.08, 44.94);
  world.players[0].heading = 96.77;
  initializeFreeRoamSpatialBridge(world, SPATIAL_LAB_FREE_ROAM_BINDING);

  const ready = world.events.find(event => event.type === "location-action-ready");
  assert.ok(ready, "the player should be told when the entrance can actually be activated");
  assert.match(ready.text, /Теперь нажми действие/);

  const prepared = prepareFreeRoamSpatialInput(world, 0, {action: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.equal(prepared.action, false);
  assert.equal(world.players[0].spatialLocationId, SPATIAL_LAB_FREE_ROAM_BINDING.id);
  assert.ok(world.events.some(event => event.type === "location-enter"));
});

test("the spatial bridge reads the existing jump height as real z and stairs change only the floor height", () => {
  const gate = passage("world.passage.shore-to-spatial-lab");
  const stairs = passage("lab.connection.stairs");
  const world = worldAt(gate.from.position.x, gate.from.position.y);
  initializeFreeRoamSpatialBridge(world, SPATIAL_LAB_FREE_ROAM_BINDING);
  prepareFreeRoamSpatialInput(world, 0, {action: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  prepareFreeRoamSpatialInput(world, 0, {action: false}, SPATIAL_LAB_FREE_ROAM_BINDING);

  const player = world.players[0];
  player.x = stairs.from.position.x;
  player.y = stairs.from.position.y;
  const beforeInput = {right: true, jump: true, action: false};
  const unchanged = prepareFreeRoamSpatialInput(world, 0, beforeInput, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.deepEqual(unchanged, beforeInput, "ordinary movement and jump inputs pass through untouched");
  assert.equal(player.x, stairs.from.position.x);
  assert.equal(player.y, stairs.from.position.y);

  prepareFreeRoamSpatialInput(world, 0, {action: true}, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.equal(player.spatialSpaceId, "lab.upper.room");
  assert.equal(player.spatialFloorZ, 6);
  assert.equal(player.z, 6);

  player.airborne = true;
  player.jumpHeight = 1.35;
  player.jumpVelocity = 3.2;
  syncFreeRoamSpatialBridge(world, SPATIAL_LAB_FREE_ROAM_BINDING);
  assert.equal(player.z, 7.35, "z is the current floor plus the already-existing jumpHeight");
  assert.equal(player.jumpHeight, 1.35, "the bridge does not run its own jump physics");
  assert.equal(player.jumpVelocity, 3.2, "the bridge does not change the existing jump velocity while jumping");
});

test("walking remains the old free-roam implementation while the new bridge adds location and z replication", () => {
  const core = fs.readFileSync(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../public/src/spatial/spatial-free-roam-bridge.js", import.meta.url), "utf8");
  const replication = fs.readFileSync(new URL("../public/src/free-roam-replication-v2.js", import.meta.url), "utf8");

  assert.match(core, /base\.stepFreeWorld\(world, safeDt\)/);
  assert.match(core, /syncFreeRoamSpatialBridge\(world, SPATIAL_LAB_FREE_ROAM_BINDING\)/);
  assert.match(core, /prepareFreeRoamSpatialInput\(world, playerIndex, nextInput, SPATIAL_LAB_FREE_ROAM_BINDING\)/);
  assert.doesNotMatch(bridge, /jumpVelocity\s*[-+]=/);
  assert.doesNotMatch(bridge, /jumpHeight\s*\+=/);
  assert.match(replication, /target\.spatialLocationId = source\.spatialLocationId \|\| null/);
  assert.match(replication, /target\.z = rounded\(source\.z\)/);
});
