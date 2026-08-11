import test from "node:test";
import assert from "node:assert/strict";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=1";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "../public/src/vessel/systems/vessel-deck-input-bridge-system.js?v=5";
import {VESSEL_MODULE_REPAIR_SYSTEMS} from "../public/src/vessel/systems/vessel-module-repair-system.js?v=5";
import {VESSEL_ZONE_WATER_SYSTEMS} from "../public/src/vessel/systems/vessel-zone-water-system.js?v=2";

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
    inputs: [{repair: false, pump: false}], operationInputs: [{repair: false, pump: false}], previousInputs: [{repair: false, pump: false}], operationPreviousInputs: [{repair: false, pump: false}],
    freeActivities: {inputs: [{repair: false, pump: false}], previousInputs: [{repair: false, pump: false}], presence: [true]},
    events: [],
  };
  return {registry, definition, instance, boat, world, entry: {registry, definition, instance, boat}};
}

const beforeInput = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "before-input");
const repairSystem = VESSEL_MODULE_REPAIR_SYSTEMS[0];
const waterBefore = VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === "before-step");
const waterAfter = VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === "after-step");

function capture(world, entry, repair, pump = false) {
  beforeInput.run({world, nativeVessels: [entry], playerIndex: 0, input: {repair, pump, attack: false, guide: false}});
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

test("impossible pump repair is announced once per continuous hold", () => {
  const {registry, instance, boat, world, entry} = fixture();
  instance.interior.claims["medium-pump-repair-control"] = 0;
  instance.occupants["0"] = {deckId: "medium-engine-deck", zoneId: "medium-engine-room", x: 1.35, y: -1.45, heading: 0, mode: "walking"};
  instance.modules["bilge-pump"].health = 35;
  instance.modules["bilge-pump"].enabled = true;
  boat.repairPatches = 0;

  capture(world, entry, true);
  for (let index = 0; index < 80; index += 1) {
    repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
    world.time += 0.1;
  }
  const denialsDuringHold = world.events.filter(event => event.type === "vessel-module-repair-denied");
  assert.equal(denialsDuringHold.length, 1, "one physical hold must not repeat the same impossible-repair speech");
  assert.equal(denialsDuringHold[0].reason, "no-repair-patches");
  assert.match(denialsDuringHold[0].text, /ремонт невозможен/i);

  capture(world, entry, false);
  repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
  capture(world, entry, true);
  repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
  assert.equal(world.events.filter(event => event.type === "vessel-module-repair-denied").length, 2, "a deliberate release and new hold may report the reason once again");
});

test("bridge v5 repair input reaches the module repair reader and a repaired engine really restarts", () => {
  const {registry, instance, boat, world, entry} = fixture();
  instance.interior.claims["medium-engine-repair-control"] = 0;
  instance.modules.engine.health = 20;
  instance.modules.engine.enabled = false;
  boat.engineStalled = true;
  boat.restartProgress = 0;

  capture(world, entry, true);
  for (let index = 0; index < 56; index += 1) {
    repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
    world.time += 0.1;
  }

  assert.equal(instance.modules.engine.health, 75);
  assert.equal(instance.modules.engine.enabled, true, "repair must re-enable the actual propulsion module");
  assert.equal(boat.engineStalled, true, "repair completion hands off to the normal restart lifecycle");
  assert.ok(world.events.some(event => event.type === "vessel-module-repair-complete" && event.moduleId === "engine"));

  capture(world, entry, false);
  for (let index = 0; index < 13; index += 1) {
    const eventStart = world.events.length;
    waterBefore.run({world, nativeVessels: [entry], dt: 0.1, eventStart});
    waterAfter.run({world, nativeVessels: [entry], dt: 0.1, eventStart});
    world.time += 0.1;
  }

  assert.equal(boat.engineStalled, false, "a repaired, fueled, dry engine must leave the stalled state");
  assert.equal(boat.restartProgress, 0);
  assert.ok(world.events.some(event => event.type === "engine-water-restart" && event.boatId === boat.id), "the player must receive a real engine-start event after repair");
});
