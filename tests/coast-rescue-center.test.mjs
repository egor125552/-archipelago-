import test from "node:test";
import assert from "node:assert/strict";

import {
  COAST_RESCUE_CENTER_LOCATION,
  createCoastRescueCenter,
} from "../public/src/locations/coast-rescue-center/location.js";
import {FREE_ROAM_SPATIAL_LOCATIONS} from "../public/src/locations/free-roam-location-registry.js";

const LEVELS = ["rescue.basement", "rescue.ground", "rescue.second", "rescue.roof"];

test("coast rescue center compiles as four true-height levels connected by shared stairs", () => {
  const {compiled, runtime} = createCoastRescueCenter();
  assert.equal(compiled.id, "location.coast.rescue-center");
  assert.deepEqual(compiled.spaces.map(space => space.id), LEVELS);
  assert.deepEqual(compiled.connections.map(connection => connection.kind), ["stairs", "stairs", "stairs"]);
  assert.ok(compiled.connections.every(connection => connection.bidirectional));
  assert.ok(compiled.connections.every(connection => connection.interactionRange === 3.4));
  assert.ok(compiled.connections.every(connection => connection.discoverRadius === 9));

  runtime.spawnEntity({id: "player.rescue", spawnId: "rescue.spawn.entry"});
  assert.equal(runtime.getEntity("player.rescue").spaceId, "rescue.ground");
  assert.equal(runtime.getEntityWorldPosition("player.rescue").z, 0);

  runtime.transitionEntity("player.rescue", "rescue.connection.basement-ground");
  assert.equal(runtime.getEntity("player.rescue").spaceId, "rescue.basement");
  assert.equal(runtime.getEntityWorldPosition("player.rescue").z, -3);

  runtime.transitionEntity("player.rescue", "rescue.connection.basement-ground");
  runtime.transitionEntity("player.rescue", "rescue.connection.ground-second");
  assert.equal(runtime.getEntity("player.rescue").spaceId, "rescue.second");
  assert.equal(runtime.getEntityWorldPosition("player.rescue").z, 4);

  runtime.transitionEntity("player.rescue", "rescue.connection.second-roof");
  assert.equal(runtime.getEntity("player.rescue").spaceId, "rescue.roof");
  assert.equal(runtime.getEntityWorldPosition("player.rescue").z, 8);

  const route = runtime.getModule("rescue.navigation").findRoute({fromSpaceId: "rescue.basement", toSpaceId: "rescue.roof"});
  assert.deepEqual(route.spaces, LEVELS);
});

test("rescue center has spoken landmarks on every level", () => {
  const byId = new Map(COAST_RESCUE_CENTER_LOCATION.spaces.map(space => [space.id, space]));
  for (const id of LEVELS) {
    const space = byId.get(id);
    assert.ok(space, `${id} must exist`);
    assert.ok(space.label.length > 0);
    assert.ok(space.anchors.some(anchor => anchor.label), `${id} needs a spoken anchor`);
    assert.ok(space.objects.every(object => object.label), `${id} objects need spoken labels`);
  }
});

test("free roam registers rescue center as a second accessible shore location", () => {
  const entry = FREE_ROAM_SPATIAL_LOCATIONS.find(item => item.definition.id === "location.coast.rescue-center");
  assert.ok(entry, "rescue center must be registered");
  assert.equal(entry.definition.presentation.label, "Береговой спасательный центр");
  assert.deepEqual(entry.portal.position, {x: 150, y: 18, z: 0});
  assert.equal(entry.portal.radius, 12);
  assert.equal(entry.portal.discoverRadius, 22);
  assert.equal(entry.portal.spawnId, "rescue.spawn.entry");
  assert.equal(entry.portal.exitAnchorId, "rescue.anchor.entry");
});
