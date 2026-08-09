import test from "node:test";
import assert from "node:assert/strict";
import {
  attachVesselArchitecture,
  nativeVesselForBoat,
  spawnVessel,
} from "../public/src/vessel/vessel-runtime.js";
import {VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS} from "../public/src/vessel/systems/vessel-water-authority-persistence-system.js?v=1";

function freshWorld() {
  return {time: 0, boats: [], players: [], events: []};
}

function medium(world) {
  return spawnVessel(world, "medium-crew-vessel", {
    x: 210,
    y: 92,
    heading: 180,
    state: {owner: null, driver: null, crew: [], mediumCrewMarker: true},
  });
}

test("authoritative static module health survives a saved-world reload and zero health is never resurrected", () => {
  const world = freshWorld();
  const spawned = medium(world);
  const entry = nativeVesselForBoat(world, spawned.boat.id);
  entry.instance.modules.engine.health = 0;
  entry.instance.modules.engine.enabled = false;
  entry.instance.modules.engine.repairProgress = 3.2;
  entry.instance.modules["bilge-pump"].health = 25;
  entry.instance.modules["bilge-pump"].enabled = true;

  // A normal architecture sync writes persistent static module state to the boat.
  nativeVesselForBoat(world, spawned.boat.id);
  const saved = structuredClone(world);
  const persisted = saved.boats[spawned.boat.id].vesselRuntimeState;
  assert.equal(persisted.version, 2);
  assert.equal(persisted.staticModules.engine.health, 0);
  assert.equal(persisted.staticModules.engine.enabled, false);
  assert.equal(persisted.staticModules["bilge-pump"].health, 25);
  assert.equal(persisted.staticModules.engine.repairProgress, undefined, "partial repair progress must not survive reconnect/reload");

  attachVesselArchitecture(saved);
  const restored = nativeVesselForBoat(saved, spawned.boat.id);
  assert.equal(restored.instance.modules.engine.health, 0);
  assert.equal(restored.instance.modules.engine.enabled, false);
  assert.equal(restored.instance.modules["bilge-pump"].health, 25);
  assert.equal(saved.boats[spawned.boat.id].engineStalled, true, "disabled authoritative engine must be reflected into legacy movement state");
});

test("zonal flooding authority marker persists in compartment state and prevents repeat migration after reload", () => {
  const world = freshWorld();
  const spawned = medium(world);
  const entry = nativeVesselForBoat(world, spawned.boat.id);
  for (const zone of Object.values(entry.instance.zones)) zone.flooding = 40;
  entry.boat.water = 40;
  entry.instance.interior ||= {};
  entry.instance.interior.waterBridge ||= {};
  entry.instance.interior.waterBridge.authorityVersion = 2;
  entry.instance.interior.waterBridge.initialized = true;

  const persist = VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS.find(system => system.phase === "after-step");
  persist.run({nativeVessels: [entry]});
  nativeVesselForBoat(world, spawned.boat.id);

  const saved = structuredClone(world);
  const deckZones = saved.boats[spawned.boat.id].vesselRuntimeState.deck.zones;
  assert.equal(deckZones["medium-aft-zone"].floodAuthorityVersion, 2);
  assert.equal(deckZones["medium-cabin-zone"].floodAuthorityVersion, 2);
  assert.equal(deckZones["medium-engine-room"].floodAuthorityVersion, 2);

  attachVesselArchitecture(saved);
  const restored = nativeVesselForBoat(saved, spawned.boat.id);
  assert.notEqual(restored.instance.interior.waterBridge?.authorityVersion, 2, "transient bridge metadata itself is intentionally not persisted");
  const restore = VESSEL_WATER_AUTHORITY_PERSISTENCE_SYSTEMS.find(system => system.phase === "before-step");
  restore.run({nativeVessels: [restored]});
  assert.equal(restored.instance.interior.waterBridge.authorityVersion, 2);
  assert.deepEqual(
    ["medium-aft-zone", "medium-cabin-zone", "medium-engine-room"].map(id => restored.instance.zones[id].flooding),
    [40, 40, 40],
    "legitimate equal compartment flooding must remain equal after authority marker restore",
  );
});
