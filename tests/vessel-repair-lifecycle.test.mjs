import test from "node:test";
import assert from "node:assert/strict";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=1";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "../public/src/vessel/systems/vessel-deck-input-bridge-system.js?v=3";
import {VESSEL_MODULE_REPAIR_SYSTEMS} from "../public/src/vessel/systems/vessel-module-repair-system.js?v=4";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {instanceId: "medium:repair-lifecycle", legacyBoatId: 4, state: definition.runtimeDefaults});
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    hull: 180,
    hullMax: 220,
    fuel: 80,
    engineTemp: 40,
    repairPatches: 4,
    sunk: false,
    crew: [0, null],
  };
  instance.occupants["0"] = {deckId: "medium-engine-deck", zoneId: "medium-engine-room", x: -1.35, y: -1.45, heading: 0, mode: "walking"};
  const world = {
    time: 0,
    boats: [null, null, null, null, boat],
    players: [{mode: "boat", activeBoat: 4, combat: {alive: true}}],
    inputs: [{repair: false}], operationInputs: [{repair: false}], previousInputs: [{repair: false}], operationPreviousInputs: [{repair: false}],
    freeActivities: {inputs: [{repair: false}], previousInputs: [{repair: false}], presence: [true]},
    events: [],
  };
  return {registry, definition, instance, boat, world, entry: {registry, definition, instance, boat}};
}

const beforeInput = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "before-input");
const repairSystem = VESSEL_MODULE_REPAIR_SYSTEMS[0];

function capture(world, entry, repair) {
  beforeInput.run({world, nativeVessels: [entry], playerIndex: 0, input: {repair, attack: false, pump: false, guide: false}});
}

test("leaving a repair station cancels an unfinished service and clears its owner state", () => {
  const {registry, instance, boat, world, entry} = fixture();
  instance.interior.claims["medium-engine-repair-control"] = 0;
  instance.modules.engine.health = 60;
  instance.modules.engine.enabled = true;
  capture(world, entry, true);
  repairSystem.run({world, registry, nativeVessels: [entry], dt: 1});
  assert.equal(instance.modules.engine.repairActive, true);
  assert.equal(instance.modules.engine.enabled, false, "engine must be offline while physically being serviced");

  delete instance.interior.claims["medium-engine-repair-control"];
  repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
  assert.equal(instance.modules.engine.repairActive, false);
  assert.equal(instance.modules.engine.repairProgress, 0);
  assert.equal(instance.modules.engine.repairLatched, false);
  assert.equal(instance.modules.engine.repairOwner, undefined);
  assert.equal(instance.modules.engine.enabled, true, "an originally working engine is restored when unfinished service is abandoned");
  assert.equal(boat.engineStalled, true, "authority still requires the normal engine restart lifecycle");
  assert.ok(world.events.some(event => event.type === "vessel-module-repair-cancelled"));
});

test("holding repair after completion cannot consume a second plate", () => {
  const {registry, instance, boat, world, entry} = fixture();
  instance.interior.claims["medium-pump-repair-control"] = 0;
  instance.occupants["0"] = {deckId: "medium-engine-deck", zoneId: "medium-engine-room", x: 1.35, y: -1.45, heading: 0, mode: "walking"};
  instance.modules["bilge-pump"].health = 0;
  instance.modules["bilge-pump"].enabled = false;
  capture(world, entry, true);

  for (let index = 0; index < 120; index += 1) {
    repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
    world.time += 0.1;
  }
  assert.equal(boat.repairPatches, 3, "one continuous hold may consume only one plate");
  assert.equal(instance.modules["bilge-pump"].health, 60);
  assert.equal(instance.modules["bilge-pump"].repairLatched, true);

  capture(world, entry, false);
  repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
  assert.equal(instance.modules["bilge-pump"].repairLatched, false, "release rearms the repair control for a deliberate second cycle");
});
