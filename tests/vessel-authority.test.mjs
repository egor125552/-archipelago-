import test from "node:test";
import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=1";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS, capturedVesselSharedInput} from "../public/src/vessel/systems/vessel-deck-input-bridge-system.js?v=2";
import {VESSEL_MODULE_REPAIR_SYSTEMS} from "../public/src/vessel/systems/vessel-module-repair-system.js?v=1";
import {VESSEL_ZONE_WATER_SYSTEMS} from "../public/src/vessel/systems/vessel-zone-water-system.js?v=2";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {
    instanceId: "medium:authority-test",
    legacyBoatId: 4,
    state: definition.runtimeDefaults,
  });
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    label: definition.presentation.label,
    x: 210,
    y: 92,
    heading: 0,
    owner: 0,
    driver: null,
    crew: [0, null],
  };
  instance.occupants["0"] = {
    deckId: "medium-aft-deck",
    zoneId: "medium-aft-zone",
    x: -1.75,
    y: -2.25,
    heading: 0,
    mode: "walking",
  };
  const world = {
    time: 10,
    boats: [null, null, null, null, boat],
    players: [{mode: "boat", activeBoat: 4, x: boat.x, y: boat.y, heading: 0, combat: {alive: true}}],
    inputs: [{attack: false, pump: false, repair: false}],
    operationInputs: [{attack: false, pump: false, repair: false}],
    freeActivities: {inputs: [{attack: false, pump: false, repair: false}], previousInputs: [{}], presence: [true]},
    events: [],
  };
  return {registry, definition, instance, boat, world, entry: {registry, definition, instance, boat}};
}

function bridge(phase) {
  return VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === phase);
}

function water(phase) {
  return VESSEL_ZONE_WATER_SYSTEMS.find(system => system.phase === phase);
}

test("medium vessel explicitly owns modular subsystems and exposes physical repair posts", () => {
  const {definition} = fixture();
  assert.equal(definition.subsystemAuthority.flooding, "vessel-zonal-v2");
  assert.equal(definition.subsystemAuthority.damage, "vessel-zonal-v1");
  assert.equal(definition.subsystemAuthority.repair, "vessel-modules-v1");
  assert.equal(definition.subsystemAuthority.audio, "vessel-custom-v1");

  const objects = definition.decks.flatMap(deck => deck.objects || []);
  const engineRepair = objects.find(object => object.id === "medium-engine-repair-station");
  const pumpRepair = objects.find(object => object.id === "medium-pump-repair-station");
  assert.equal(engineRepair?.controlsModule, "engine");
  assert.deepEqual(engineRepair?.inputAuthority, ["repair"]);
  assert.equal(pumpRepair?.controlsModule, "bilge-pump");
  assert.deepEqual(pumpRepair?.inputAuthority, ["repair"]);
});

test("weapon station owns attack so personal weapon input is not restored", () => {
  const {world, entry, instance} = fixture();
  instance.interior.claims["medium-pistol-control"] = 0;
  const input = {attack: true, pump: false, repair: false, guide: false};

  bridge("before-input").run({world, nativeVessels: [entry], playerIndex: 0, input});
  const captured = capturedVesselSharedInput(world, 0);
  assert.equal(captured.attack, true, "vessel weapon must retain the raw trigger");

  // Walkable-vessel sanitization and base.setPlayerInput leave legacy stores false.
  world.inputs[0].attack = false;
  world.operationInputs[0].attack = false;
  world.freeActivities.inputs[0].attack = false;
  bridge("after-input").run({world, nativeVessels: [entry], playerIndex: 0, input});

  assert.equal(world.inputs[0].attack, false);
  assert.equal(world.operationInputs[0].attack, false);
  assert.equal(world.freeActivities.inputs[0].attack, false, "personal combat must not receive the mounted-gun trigger");
});

test("legacy shared attack is restored when no vessel station owns it", () => {
  const {world, entry} = fixture();
  const input = {attack: true, pump: false, repair: false, guide: false};
  bridge("before-input").run({world, nativeVessels: [entry], playerIndex: 0, input});
  world.inputs[0].attack = false;
  world.operationInputs[0].attack = false;
  world.freeActivities.inputs[0].attack = false;
  bridge("after-input").run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(world.freeActivities.inputs[0].attack, true, "walking player keeps normal personal weapon control");
});

test("old equalized saved water migrates into compartments without changing total aggregate", () => {
  const {world, entry, instance, boat} = fixture();
  for (const zone of Object.values(instance.zones)) zone.flooding = 60;
  boat.water = 60;
  boat.leak = 0;

  water("before-step").run({world, nativeVessels: [entry], dt: 0.05, eventStart: 0});
  const values = ["medium-aft-zone", "medium-cabin-zone", "medium-engine-room"].map(id => instance.zones[id].flooding);
  assert.ok(new Set(values.map(value => Math.round(value))).size > 1, "migration must not preserve fake equal flooding in every compartment");

  // Simulate legacy core doing no damage, then restore authority state.
  water("after-step").run({world, nativeVessels: [entry], dt: 0.05, eventStart: 0});
  assert.ok(Math.abs(boat.water - 60) < 0.15, `aggregate water should remain 60, got ${boat.water}`);
  assert.equal(instance.interior.connections["medium-cabin-door-in"].state, "closed");
  assert.equal(instance.interior.connections["medium-engine-hatch-down"].state, "closed");
});

test("broken bilge pump cannot remove zonal water", () => {
  const {world, entry, instance, boat} = fixture();
  instance.zones["medium-aft-zone"].flooding = 30;
  boat.water = 10;
  const pump = instance.modules["bilge-pump"];
  pump.health = 0;
  pump.enabled = false;
  const input = {attack: false, pump: true, repair: false, guide: false};
  bridge("before-input").run({world, nativeVessels: [entry], playerIndex: 0, input});

  water("before-step").run({world, nativeVessels: [entry], dt: 0.1, eventStart: 0});
  water("after-step").run({world, nativeVessels: [entry], dt: 0.1, eventStart: 0});
  assert.equal(instance.zones["medium-aft-zone"].flooding, 30);
  assert.equal(boat.pumpActive, false);
  assert.ok(world.events.some(event => event.type === "vessel-pump-disabled"));
});

test("engine repair post repairs only engine, consumes one plate, and does not patch hull", () => {
  const {world, registry, entry, instance, boat} = fixture();
  instance.occupants["0"] = {deckId: "medium-engine-deck", zoneId: "medium-engine-room", x: -1.35, y: -1.45, heading: 0, mode: "walking"};
  instance.interior.claims["medium-engine-repair-control"] = 0;
  instance.modules.engine.health = 20;
  instance.modules.engine.enabled = false;
  boat.engineStalled = true;
  boat.hull = 150;
  boat.repairPatches = 3;
  const input = {attack: false, pump: false, repair: true, guide: false};
  bridge("before-input").run({world, nativeVessels: [entry], playerIndex: 0, input});

  const repairSystem = VESSEL_MODULE_REPAIR_SYSTEMS[0];
  for (let index = 0; index < 56; index += 1) {
    repairSystem.run({world, registry, nativeVessels: [entry], dt: 0.1});
    world.time += 0.1;
  }

  assert.equal(instance.modules.engine.health, 75);
  assert.equal(instance.modules.engine.enabled, true);
  assert.equal(boat.engineStalled, false);
  assert.equal(boat.repairPatches, 2);
  assert.equal(boat.hull, 150, "module repair must not secretly repair hull");
  assert.ok(world.events.some(event => event.type === "vessel-module-repair-complete" && event.moduleId === "engine"));
});

test("pump repair post restores the pump as a separate module", () => {
  const {world, registry, entry, instance, boat} = fixture();
  instance.occupants["0"] = {deckId: "medium-engine-deck", zoneId: "medium-engine-room", x: 1.35, y: -1.45, heading: 0, mode: "walking"};
  instance.interior.claims["medium-pump-repair-control"] = 0;
  instance.modules["bilge-pump"].health = 0;
  instance.modules["bilge-pump"].enabled = false;
  boat.repairPatches = 2;
  const input = {attack: false, pump: false, repair: true, guide: false};
  bridge("before-input").run({world, nativeVessels: [entry], playerIndex: 0, input});

  for (let index = 0; index < 43; index += 1) {
    VESSEL_MODULE_REPAIR_SYSTEMS[0].run({world, registry, nativeVessels: [entry], dt: 0.1});
    world.time += 0.1;
  }

  assert.equal(instance.modules["bilge-pump"].health, 60);
  assert.equal(instance.modules["bilge-pump"].enabled, true);
  assert.equal(boat.repairPatches, 1);
});

test("medium test engine remains one ordinary binary MP3 asset", async () => {
  const path = new URL("../public/assets/audio/vessels/medium-crew-engine-test.mp3", import.meta.url);
  const info = await stat(path);
  assert.ok(info.size > 1024, `engine asset is unexpectedly small: ${info.size}`);
  const head = (await readFile(path)).subarray(0, 3);
  const id3 = head.toString("ascii") === "ID3";
  const frameSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  assert.ok(id3 || frameSync, "engine asset must be a real MP3, not HTML/text/chunks");
});
