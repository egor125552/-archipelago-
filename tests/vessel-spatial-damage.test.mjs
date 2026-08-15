import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, stepFreeWorld} from "../public/src/free-roam-core-v8.js";
import {nativeVesselForBoat, vesselRegistry} from "../public/src/vessel/vessel-runtime.js?v=2";
import {
  applySpatialVesselImpact,
  captureVesselSpatialDamageState,
  reconcileHostileVesselSpatialDamage,
  syncLegacyVesselDamageEffects,
} from "../public/src/vessel/vessel-spatial-damage.js?v=1";
import {setVesselOccupantPosition, vesselLocalToWorld} from "../public/src/vessel/vessel-interior.js";
import {STRESS_TEST_VESSEL_TYPE} from "../public/src/vessel/stress-test-vessel-config.js?v=2";

function stressBoat(world) {
  return (world.boats || []).find(boat => boat?.vesselType === STRESS_TEST_VESSEL_TYPE || boat?.boatType === STRESS_TEST_VESSEL_TYPE);
}

function armoredBoat(world) {
  return (world.boats || []).find(boat => boat?.vesselType === "dual-turret-patrol" || boat?.boatType === "dual-turret-patrol");
}

function readyWorld() {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.05);
  return world;
}

test("walkable armored and fast vessels opt into one zonal damage authority", () => {
  const registry = vesselRegistry();
  for (const typeId of ["dual-turret-patrol", STRESS_TEST_VESSEL_TYPE]) {
    const definition = registry.resolveVesselType(typeId);
    assert.ok(definition, `${typeId} must be registered`);
    assert.equal(definition.capabilities.walkableInterior, true);
    assert.equal(definition.capabilities.zonalDamage, true);
    assert.equal(definition.damage?.mode, "zonal");
    assert.equal(definition.subsystemAuthority?.damage, "vessel-spatial-damage-v1");
  }
  assert.equal(registry.resolveVesselType("standard").damage?.mode, "global", "ordinary small boat keeps its existing global model");
});

test("a low aft blast on the fast boat damages lower-deck machinery but not the pistol above", () => {
  const world = readyWorld();
  const boat = stressBoat(world);
  assert.ok(boat);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  const pistolBefore = entry.instance.modules["stress-pistol"].health;
  const impactPoint = vesselLocalToWorld(boat, {x: 0, y: -2.45});
  const result = applySpatialVesselImpact(world, entry, {kind: "blast", damage: 72, playerDamage: 0, damagePlayers: false, impactPoint, impactHeight: 0.7, projectileId: "test-low-aft-blast"});
  assert.equal(result.deckId, "stress-aft-deck");
  assert.equal(result.zoneId, "stress-aft-zone");
  assert.ok(result.modules.some(hit => hit.moduleId.startsWith("engine-")), "lower aft impact must be able to hit one of the physical engine modules");
  assert.equal(entry.instance.modules["stress-pistol"].health, pistolBefore, "lower-deck blast must not magically damage the pistol station above");
});

test("a high control-deck blast can damage the fast boat pistol installation", () => {
  const world = readyWorld();
  const boat = stressBoat(world);
  assert.ok(boat);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  const before = entry.instance.modules["stress-pistol"].health;
  const impactPoint = vesselLocalToWorld(boat, {x: 1.15, y: 1.45});
  const result = applySpatialVesselImpact(world, entry, {kind: "blast", damage: 68, playerDamage: 0, damagePlayers: false, impactPoint, impactHeight: 2.15, fromAbove: true, projectileId: "test-control-deck-blast"});
  assert.equal(result.deckId, "stress-control-deck");
  assert.equal(result.zoneId, "stress-control-zone");
  assert.ok(result.modules.some(hit => hit.moduleId === "stress-pistol"), "blast beside the pistol hardpoint must reach the pistol module");
  assert.ok(entry.instance.modules["stress-pistol"].health < before);
});

test("armored patrol spends exterior armor before the selected compartment and module", () => {
  const world = readyWorld();
  const boat = armoredBoat(world);
  assert.ok(boat);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  const armorBefore = boat.armor;
  const hullBefore = boat.hull;
  const impactPoint = vesselLocalToWorld(boat, {x: 2.45, y: 1.2});
  const result = applySpatialVesselImpact(world, entry, {kind: "heavy-bullet", damage: 40, playerDamage: 0, damagePlayers: false, impactPoint, impactHeight: 0.7, sourcePoint: vesselLocalToWorld(boat, {x: 14, y: 1.2}), projectileId: "test-armored-side-hit"});
  assert.equal(result.deckId, "armored-main-deck");
  assert.ok(result.armorDamage > 0);
  assert.ok(boat.armor < armorBefore);
  assert.ok(result.structuralDamage < 40, "intact armor must reduce energy entering the compartment");
  assert.ok(boat.hull < hullBefore);
  assert.ok(result.modules.some(hit => hit.moduleId === "starboard-turret"), "a hit beside the right hardpoint should reach the right installation first");
});

test("an internal blast damages occupants on its deck instead of every person aboard", () => {
  const world = readyWorld();
  const boat = stressBoat(world);
  assert.ok(boat);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  const lower = world.players[0];
  const upper = world.players[1];
  lower.mode = "boat"; lower.activeBoat = boat.id; lower.combat.health = 100; lower.combat.alive = true;
  upper.mode = "boat"; upper.activeBoat = boat.id; upper.combat.health = 100; upper.combat.alive = true;
  boat.crew = [0, 1];
  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "stress-aft-deck", x: 0, y: -2.4, heading: 0});
  setVesselOccupantPosition(entry.definition, entry.instance, 1, {deckId: "stress-control-deck", x: 0, y: 1.2, heading: 0});
  const result = applySpatialVesselImpact(world, entry, {kind: "blast", damage: 24, playerDamage: 18, impactPoint: vesselLocalToWorld(boat, {x: 0, y: -2.3}), impactHeight: 0.7, projectileId: "test-crew-deck-isolation"});
  assert.equal(result.deckId, "stress-aft-deck");
  assert.ok(lower.combat.health < 100, "crew member standing beside the blast must be hurt");
  assert.equal(upper.combat.health, 100, "crew member on another deck must not receive the same automatic hit");
});

test("destroyed architectural turret disables the legacy armored controller and repair restores it", () => {
  const world = readyWorld();
  const boat = armoredBoat(world);
  assert.ok(boat);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  const module = entry.instance.modules["port-turret"];
  const legacyTurret = [...world.freeDualTurretBoat.turrets].sort((a, b) => Number(a.side) - Number(b.side))[0];
  module.health = 0;
  module.enabled = false;
  syncLegacyVesselDamageEffects({world, nativeVessels: [entry]}, false);
  assert.equal(legacyTurret.spatialDisabled, true);
  assert.equal(Number.isFinite(legacyTurret.cooldown), false, "destroyed turret must be unable to fire through the old controller");
  module.health = 100;
  module.enabled = true;
  syncLegacyVesselDamageEffects({world, nativeVessels: [entry]}, false);
  assert.equal(legacyTurret.spatialDisabled, false);
  assert.equal(Number.isFinite(legacyTurret.cooldown), true, "repair must make the old controller usable again");
});

test("hostile damage reconciliation does not lose hits when the bounded event queue rolls over", () => {
  const world = readyWorld();
  const boat = stressBoat(world);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  world.events = Array.from({length: 260}, (_, index) => ({type: "old-event", serial: index}));
  captureVesselSpatialDamageState(world, [entry]);
  const eventStart = world.events.length;
  boat.hull -= 1.5;
  boat.leak += 0.22;
  const hit = {type: "enemy-bullet-boat-hit", targetBoat: boat.id, sourcePursuerId: "pursuer-2", damage: 1.5, x: boat.x, y: boat.y};
  world.events.push(hit);
  world.events.splice(0, world.events.length - 260);
  reconcileHostileVesselSpatialDamage({world, nativeVessels: [entry], eventStart});
  assert.equal(hit.vesselSpatialDamageVersion, "1.0.0");
  assert.ok(hit.deckId, "the fresh hit must still be spatially reconciled after queue rollover");
});

test("ordinary, heavy, crew and ram hostile events all enter the same spatial vessel damage path", async t => {
  const cases = [
    {name: "ordinary pursuer bullet", event: {type: "enemy-bullet-boat-hit", sourcePursuerId: "pursuer-2", damage: 1.5}, undoHull: 1.5, undoLeak: 0.22},
    {name: "hostile crew bullet", event: {type: "enemy-bullet-boat-hit", gunnerId: "missing-gunner"}, undoHull: 3, undoLeak: 0.14},
    {name: "heavy pursuer bullet", event: {type: "heavy-bullet-boat-hit"}, undoHull: 5.5, undoLeak: 0.22},
    {name: "ordinary enemy ram", event: {type: "enemy-ram-hit", sourcePursuerId: "threat-boat-1"}, undoHull: 3.6, undoLeak: 0.32},
    {name: "elite ram", event: {type: "elite-ram-impact", targetDamage: 20}, undoHull: 20, undoLeak: 1.8},
  ];
  for (const item of cases) await t.test(item.name, () => {
    const world = readyWorld();
    const boat = stressBoat(world);
    const entry = nativeVesselForBoat(world, boat.id);
    assert.ok(entry);
    captureVesselSpatialDamageState(world, [entry]);
    const eventStart = world.events.length;
    boat.hull = Math.max(0.05, boat.hull - item.undoHull);
    boat.leak = Math.max(0, boat.leak + item.undoLeak);
    const event = {...item.event, targetBoat: boat.id, x: boat.x, y: boat.y};
    world.events.push(event);
    reconcileHostileVesselSpatialDamage({world, nativeVessels: [entry], eventStart});
    assert.equal(event.vesselSpatialDamageVersion, "1.0.0");
    assert.ok(event.deckId);
    assert.ok(event.zoneId);
  });
});
