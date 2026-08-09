import test from "node:test";
import assert from "node:assert/strict";

import {reserveUnconnectedBoats} from "../public/src/free-roam-reserve-boats.js";
import {
  MEDIUM_CREW_TEST_SPAWN_DELAY,
  MEDIUM_CREW_VESSEL_SYSTEMS,
} from "../public/src/vessel/systems/medium-crew-vessel-system.js";
import {MEDIUM_CREW_SPAWN} from "../public/src/vessel/medium-crew-vessel-config.js";
import {
  nativeVesselForBoat,
  vesselRegistry,
} from "../public/src/vessel/vessel-runtime.js";

const spawner = MEDIUM_CREW_VESSEL_SYSTEMS.find(system => system.id === "medium-crew-vessel-spawner-v4");

function worldAt(time = 0) {
  return {
    time,
    boats: [],
    players: [],
    events: [],
  };
}

function runSpawner(world, nativeVessels = []) {
  spawner.run({world, registry: vesselRegistry(), nativeVessels});
  return world.boats.find(boat => boat?.mediumCrewMarker === true) || null;
}

test("medium test vessel waits five seconds before appearing at the pier", () => {
  const world = worldAt(MEDIUM_CREW_TEST_SPAWN_DELAY - 0.01);
  assert.equal(runSpawner(world), null, "bootstrap must not create the medium vessel before the delay");

  world.time = MEDIUM_CREW_TEST_SPAWN_DELAY;
  const boat = runSpawner(world);
  assert.ok(boat, "medium vessel should appear once the delay expires");
  assert.equal(boat.x, MEDIUM_CREW_SPAWN.x);
  assert.equal(boat.y, MEDIUM_CREW_SPAWN.y);
  assert.equal(boat.reserved, false);
  assert.equal(boat.sunk, false);
  assert.equal(boat.engineStalled, false);
});

test("a medium vessel parked by startup reservation is restored with propulsion authority", () => {
  const world = worldAt(MEDIUM_CREW_TEST_SPAWN_DELAY);
  const boat = runSpawner(world);
  assert.ok(boat);

  reserveUnconnectedBoats(world);
  assert.equal(boat.reserved, true);
  assert.equal(boat.sunk, true);
  assert.ok(boat.x < -900 && boat.y < -900, "startup reservation should park the vessel off-map");

  // Force the vessel runtime to observe the reserved/sunk state. Propulsion
  // authority is expected to disable the engine module while the hull is parked.
  const entry = nativeVesselForBoat(world, boat.id);
  assert.equal(entry.instance.modules.engine.enabled, false);

  world.time = MEDIUM_CREW_TEST_SPAWN_DELAY + 0.1;
  runSpawner(world, [entry]);

  assert.equal(boat.x, MEDIUM_CREW_SPAWN.x);
  assert.equal(boat.y, MEDIUM_CREW_SPAWN.y);
  assert.equal(boat.reserved, false);
  assert.equal(boat.sunk, false);
  assert.equal(boat.engineStalled, false);
  assert.equal(entry.instance.modules.engine.enabled, true, "healthy engine must be re-enabled after startup parking");
  assert.ok((Number(entry.instance.modules.engine.health) || 0) > 0);
});
