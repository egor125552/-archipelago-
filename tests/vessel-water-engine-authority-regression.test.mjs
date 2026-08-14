import test from "node:test";
import assert from "node:assert/strict";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=1";
import {VESSEL_ZONE_WATER_SYSTEMS} from "../public/src/vessel/systems/vessel-zone-water-system-v3.js?v=1";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {
    instanceId: "medium:water-engine-regression",
    legacyBoatId: 4,
    state: definition.runtimeDefaults,
  });
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    x: 190,
    y: 106,
    heading: 133,
    owner: 0,
    driver: 0,
    crew: [0, null],
    fuel: 93,
    engineTemp: 52,
    engineStalled: false,
    throttle: 0,
    water: 0,
    leak: 0,
    sunk: false,
  };
  instance.occupants["0"] = {
    deckId: "medium-aft-deck",
    zoneId: "medium-aft-zone",
    x: -1.75,
    y: -2.25,
    heading: 0,
    mode: "walking",
  };
  for (const zone of Object.values(instance.zones)) {
    zone.flooding = 0;
    zone.leakRate = 0;
  }
  instance.modules.engine.health = 100;
  instance.modules.engine.enabled = true;
  const world = {
    time: 646,
    boats: [null, null, null, null, boat],
    players: [{mode: "boat", activeBoat: 4, x: boat.x, y: boat.y, heading: 0, combat: {alive: true}}],
    inputs: [{pump: false, repair: false, up: false, down: false}],
    operationInputs: [{pump: false, repair: false, up: false, down: false}],
    freeActivities: {inputs: [{pump: false, repair: false, up: false, down: false}], presence: [true]},
    events: [],
  };
  return {definition, instance, boat, world, entry: {registry, definition, instance, boat}};
}

function water(phase) {
  return VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === phase);
}

function legacyStepThatReassertsOldWaterStall({world, entry}, dt = 0.1) {
  water("before-step").run({world, nativeVessels: [entry], dt, eventStart: world.events.length});
  // Reproduces the stale legacy result seen in FREE-GBZCW: the old boat layer
  // keeps returning engineStalled even though the authoritative compartments
  // are dry and the engine module is healthy.
  entry.boat.engineStalled = true;
  water("after-step").run({world, nativeVessels: [entry], dt, eventStart: world.events.length});
  world.time += dt;
}

test("legacy water stall cannot restart a dry architectural engine every 1.2 seconds", () => {
  const state = fixture();
  for (let index = 0; index < 40; index += 1) {
    legacyStepThatReassertsOldWaterStall(state);
    assert.equal(state.boat.engineStalled, false, `dry engine was re-stalled on tick ${index}`);
    assert.equal(state.boat.restartProgress, 0, `dry engine entered a fake restart countdown on tick ${index}`);
  }
  const restarts = state.world.events.filter(event => event.type === "engine-water-restart");
  assert.equal(restarts.length, 0, "dry healthy engine must not emit repeated water restart events");
});

test("a real vessel-owned restart still keeps its 1.2 second lifecycle", () => {
  const state = fixture();
  state.boat.engineStalled = true;
  state.instance.interior.waterBridge ||= {};
  state.instance.interior.waterBridge.authorityVersion = 2;
  state.instance.interior.waterBridge.floodDisabledModules ||= {};
  state.instance.interior.waterBridge.floodStalled = true;

  for (let index = 0; index < 11; index += 1) legacyStepThatReassertsOldWaterStall(state);
  assert.equal(state.boat.engineStalled, true, "authoritative water restart must not complete early");

  legacyStepThatReassertsOldWaterStall(state);
  assert.equal(state.boat.engineStalled, false, "authoritative water restart should complete after 1.2 seconds");
  const restartCount = state.world.events.filter(event => event.type === "engine-water-restart").length;
  assert.equal(restartCount, 1, "the real water restart must be announced exactly once");

  for (let index = 0; index < 24; index += 1) legacyStepThatReassertsOldWaterStall(state);
  assert.equal(state.boat.engineStalled, false);
  assert.equal(state.world.events.filter(event => event.type === "engine-water-restart").length, 1, "legacy layer must not start a second 1.2 second restart loop");
});
