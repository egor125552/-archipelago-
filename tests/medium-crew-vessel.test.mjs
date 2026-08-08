import test from "node:test";
import assert from "node:assert/strict";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel.js?v=1";
import {
  adjustVesselZoneWater,
  setVesselConnectionState,
  stepVesselWater,
} from "../public/src/vessel/vessel-deck-runtime.js";
import {VESSEL_MOUNTED_WEAPON_SYSTEMS} from "../public/src/vessel/systems/vessel-mounted-weapon-system.js?v=1";
import {VESSEL_ZONE_WATER_SYSTEMS} from "../public/src/vessel/systems/vessel-zone-water-system.js?v=1";
import {VESSEL_MERCHANT_RECOVERY_SYSTEMS} from "../public/src/vessel/systems/vessel-merchant-recovery-system.js?v=1";
import * as shop from "../public/src/free-roam-shop-v11.js?v=1";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {instanceId: "medium:i1", state: definition.runtimeDefaults});
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    label: definition.presentation.label,
    x: 200,
    y: 120,
    heading: 0,
    owner: 0,
    driver: null,
    crew: [0, 1],
  };
  return {registry, definition, instance, boat};
}

test("medium crew vessel is composed from shared decks, stations, modules and zonal water", () => {
  const {definition} = fixture();
  assert.equal(definition.capabilities.walkableInterior, true);
  assert.equal(definition.capabilities.zonalDamage, true);
  assert.equal(definition.runtimeDefaults.crewCapacity, 2);
  assert.equal(definition.decks.length, 3);
  assert.equal(definition.damage.mode, "zonal");

  const objects = definition.decks.flatMap(deck => deck.objects || []);
  assert.equal(objects.find(object => object.id === "medium-driver-seat")?.controlsVessel, true);
  assert.equal(objects.find(object => object.id === "medium-passenger-seat")?.stationRole, "passenger");
  assert.equal(objects.find(object => object.id === "medium-pistol-station")?.controlsModule, "medium-pistol");
  assert.equal(objects.find(object => object.id === "medium-heavy-gun-station")?.controlsModule, "medium-heavy-gun");

  const weapons = definition.modules.filter(module => module.type === "mounted-weapon");
  assert.deepEqual(weapons.map(module => module.id).sort(), ["medium-heavy-gun", "medium-pistol"]);
  assert.ok(weapons.every(module => module.config.runtimeSystem === "station-hitscan-v1"));
  assert.equal(definition.modules.find(module => module.id === "engine")?.type, "propulsion");
});

test("watertight door and hatch isolate flooding until physically opened", () => {
  const {definition, instance} = fixture();
  adjustVesselZoneWater(definition, instance, "medium-aft-zone", 80);
  stepVesselWater(definition, instance, 1);
  assert.equal(instance.zones["medium-cabin-zone"].flooding, 0, "closed watertight door must block water");

  setVesselConnectionState(definition, instance, "medium-cabin-door-in", "open");
  stepVesselWater(definition, instance, 1);
  assert.ok(instance.zones["medium-cabin-zone"].flooding > 0, "open door must let water enter the cabin");

  adjustVesselZoneWater(definition, instance, "medium-engine-room", 90);
  stepVesselWater(definition, instance, 1);
  const before = instance.zones["medium-cabin-zone"].flooding;
  assert.equal(instance.interior.connections["medium-engine-hatch-down"].state, "closed");
  assert.equal(instance.zones["medium-cabin-zone"].flooding, before, "closed engine hatch must isolate the machinery space");
});

test("generic station hitscan weapon fires only for the physical station owner", () => {
  const {definition, instance, boat} = fixture();
  instance.occupants["0"] = {deckId: "medium-aft-deck", zoneId: "medium-aft-zone", x: -1.75, y: -2.25, heading: 0, mode: "walking"};
  instance.interior.claims["medium-pistol-control"] = 0;
  instance.interior.walkableControl = {inputs: {"0": {attack: true}}, held: {}, pendingTraversal: {}, edgeAt: {}};
  const world = {
    time: 1,
    boats: [null, null, null, null, boat],
    players: [{mode: "boat", activeBoat: 4, x: boat.x, y: boat.y, heading: 0, combat: {alive: true, lockedTargetId: null}}],
    freeActivities: {presence: [true]},
    events: [],
  };
  const system = VESSEL_MOUNTED_WEAPON_SYSTEMS.find(entry => entry.phase === "before-step");
  system.run({world, dt: 0.05, nativeVessels: [{definition, instance, boat}]});
  const shot = world.events.find(event => event.type === "vessel-mounted-shot");
  assert.ok(shot);
  assert.equal(shot.moduleId, "medium-pistol");
  assert.equal(shot.stationId, "medium-pistol-station");
  assert.equal(instance.modules["medium-pistol"].ammo, 999);

  instance.interior.claims["medium-pistol-control"] = 1;
  instance.interior.walkableControl.inputs["0"].attack = true;
  system.run({world, dt: 0.05, nativeVessels: [{definition, instance, boat}]});
  assert.equal(world.events.filter(event => event.type === "vessel-mounted-shot").length, 1, "unoccupied/nonexistent operator cannot fire");
});

test("flood bridge makes compartment water authoritative and can stall the engine", () => {
  const {definition, instance, boat} = fixture();
  adjustVesselZoneWater(definition, instance, "medium-engine-room", 90);
  const world = {
    time: 2,
    boats: [null, null, null, null, boat],
    players: [{mode: "boat", activeBoat: 4, combat: {alive: true, health: 100}}],
    events: [],
  };
  const system = VESSEL_ZONE_WATER_SYSTEMS[0];
  system.run({world, dt: 0.05, nativeVessels: [{definition, instance, boat}]});
  assert.equal(instance.modules.engine.enabled, false);
  assert.equal(boat.engineStalled, true);
  assert.ok(boat.water > 0);
});

test("merchant wreck recovery opens a boat chooser when multiple fleet vessels are sunk", () => {
  const light = {id: 0, boatType: "standard", vesselType: "standard", label: "лёгкий катер", owner: 0, driver: null, crew: [0], sunk: true, hull: 0, hullMax: 100, armor: 0, armorMax: 0, water: 100, leak: 2, fuel: 50, x: 150, y: 150};
  const armored = {id: 2, boatType: "dual-turret-patrol", vesselType: "dual-turret-patrol", label: "двухместный бронекатер", owner: null, driver: null, crew: [], fleetService: true, sunk: true, hull: 0, hullMax: 300, armor: 0, armorMax: 200, water: 100, leak: 3, fuel: 50, x: 230, y: 150};
  const world = {
    time: 0,
    boats: [light, null, armored],
    players: [{mode: "foot", activeBoat: null, lastBoatId: 0, x: shop.MERCHANT.x, y: shop.MERCHANT.y, combat: {alive: true, pistolAmmo: 0, ammo: 0, megaBombAmmo: 0, weapons: {}}}],
    freeActivities: {credits: 500, inputs: [{}], previousInputs: [{}], presence: [true]},
    events: [],
  };
  shop.handleMerchantAction(world, 0);
  const state = shop.ensureShopState(world);
  state.shopSelection[0] = shop.SHOP_ITEMS.findIndex(item => item.id === "wreck-recovery");
  state.inputs[0] = {shopBuy: true};
  state.previousInputs[0] = {shopBuy: false};
  shop.updateMerchantShop(world);
  assert.ok(state.boatTargetSelection[0]);
  assert.equal(state.boatTargetSelection[0].boatIds.length, 2);
  assert.match(world.events.at(-1)?.text || "", /Выберите лодку/);
  assert.equal(light.sunk, true);
  assert.equal(armored.sunk, true);
});

test("armored patrol automatic respawn is locked behind merchant recovery", () => {
  const boat = {id: 2, label: "двухместный бронекатер", sunk: true};
  const controller = {boatId: 2, recoveryRemaining: 60, recoveryWarned30: false, recoveryWarned10: false};
  const world = {boats: [null, null, boat], freeDualTurretBoat: controller, events: []};
  VESSEL_MERCHANT_RECOVERY_SYSTEMS.find(system => system.phase === "before-step").run({world});
  assert.equal(controller.recoveryRemaining, Number.MAX_SAFE_INTEGER);
  assert.equal(controller.recoveryWarned30, true);
  assert.equal(boat.manualRecoveryOnly, true);
});
