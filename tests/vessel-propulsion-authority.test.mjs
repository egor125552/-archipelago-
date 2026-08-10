import test from "node:test";
import assert from "node:assert/strict";

import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=1";
import {VESSEL_PROPULSION_AUTHORITY_SYSTEMS} from "../public/src/vessel/systems/vessel-propulsion-authority-system.js?v=1";
import {VESSEL_ZONE_WATER_SYSTEMS} from "../public/src/vessel/systems/vessel-zone-water-system.js?v=2";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {
    instanceId: "medium:single-restart",
    legacyBoatId: 4,
    state: definition.runtimeDefaults,
  });
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    hull: 44,
    hullMax: 220,
    water: 35,
    leak: 0,
    fuel: 70,
    engineTemp: 55,
    engineStalled: true,
    restartProgress: 0,
    emergencyActive: false,
    sunk: false,
    crew: [0, null],
  };
  for (const zone of Object.values(instance.zones || {})) {
    zone.flooding = 35;
    zone.leakRate = 0;
  }
  instance.modules.engine.health = 35;
  instance.modules.engine.enabled = true;
  instance.interior ||= {};
  instance.interior.waterBridge ||= {};
  Object.assign(instance.interior.waterBridge, {
    authorityVersion: 2,
    initialized: true,
    floodStalled: true,
    floodDisabledModules: {},
  });
  const world = {
    time: 0,
    boats: [null, null, null, null, boat],
    players: [{mode: "foot", activeBoat: null, combat: {alive: true}}],
    inputs: [{}],
    operationInputs: [{}],
    previousInputs: [{}],
    operationPreviousInputs: [{}],
    freeActivities: {inputs: [{}], previousInputs: [{}], presence: [true]},
    events: [],
  };
  return {world, boat, instance, entry: {registry, definition, instance, boat}};
}

const waterBefore = VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === "before-step");
const propulsionGuard = VESSEL_PROPULSION_AUTHORITY_SYSTEMS.find(system => system.phase === "after-step");
const waterAfter = VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === "after-step");

test("modular propulsion restarts once even if the legacy loop keeps reasserting engineStalled", () => {
  const {world, boat, entry} = fixture();

  for (let index = 0; index < 60; index += 1) {
    const eventStart = world.events.length;
    waterBefore.run({world, nativeVessels: [entry], dt: 0.1, eventStart});

    // Reproduce the live FREE-8MDTE failure: the compatibility simulation
    // reports a stale legacy stall every frame after merchant recovery.
    boat.engineStalled = true;

    propulsionGuard.run({world, nativeVessels: [entry], dt: 0.1, eventStart});
    waterAfter.run({world, nativeVessels: [entry], dt: 0.1, eventStart});
    world.time += 0.1;
  }

  const restarts = world.events.filter(event => event.type === "engine-water-restart" && event.boatId === boat.id);
  assert.equal(restarts.length, 1, "one recovery must produce one engine restart, not a 1.2-second restart loop");
  assert.equal(boat.engineStalled, false);
  assert.equal(boat.restartProgress, 0);
});

test("the authority firewall never clears a genuine modular engine failure", () => {
  const {world, boat, instance, entry} = fixture();
  instance.interior.waterBridge.floodStalled = false;
  instance.modules.engine.health = 0;
  instance.modules.engine.enabled = false;
  boat.engineStalled = true;

  propulsionGuard.run({world, nativeVessels: [entry], dt: 0.1, eventStart: 0});

  assert.equal(boat.engineStalled, true, "a destroyed authoritative propulsion module must stay stalled");
});
