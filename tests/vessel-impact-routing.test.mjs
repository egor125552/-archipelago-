import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRoutedVesselBlast,
  applyRoutedVesselImpact,
  queueExternalVesselImpact,
  resolveVesselImpactZone,
} from "../public/src/vessel/vessel-impact-routing.js?v=1";
import {
  applyExternalImpacts,
  applyStagedBulletImpacts,
  captureLegacyBulletImpacts,
  snapshotLegacyFrame,
} from "../public/src/vessel/systems/vessel-impact-routing-system.js?v=1";

function makeEntry() {
  const zones = [
    {id: "aft", label: "кормовой отсек", presentation: {forms: {accusative: "кормовой отсек"}}, water: {enabled: true}},
    {id: "engine", label: "машинное отделение", presentation: {forms: {accusative: "машинное отделение"}}, water: {enabled: true}},
    {id: "cabin", label: "рубка", presentation: {forms: {accusative: "рубку"}}, water: {enabled: true}},
  ];
  const definition = {
    id: "test-zonal-vessel",
    capabilities: {damageable: true, zonalDamage: true},
    subsystemAuthority: {damage: "vessel-zonal-v1", flooding: "vessel-zonal-v2"},
    damage: {
      mode: "zonal",
      hullShare: 0.5,
      floodingPerHit: 2,
      zoneModules: {cabin: "helm", aft: "cargo"},
      zoneModuleChoices: {engine: ["engine", "pump"]},
      directionalZones: {front: "cabin", side: "engine", rear: "aft"},
      impactRegions: [
        {id: "aft-region", zoneId: "aft", shape: {outer: [[-14, -14], [14, -14], [14, -3], [-14, -3]]}, blastAnchor: [0, -8]},
        {id: "engine-region", zoneId: "engine", shape: {outer: [[-14, -3], [14, -3], [14, 3], [-14, 3]]}, blastAnchor: [0, 0]},
        {id: "cabin-region", zoneId: "cabin", shape: {outer: [[-14, 3], [14, 3], [14, 14], [-14, 14]]}, blastAnchor: [0, 8]},
      ],
    },
    decks: [
      {id: "aft-deck", zones: [zones[0]]},
      {id: "engine-deck", zones: [zones[1]]},
      {id: "cabin-deck", zones: [zones[2]]},
    ],
  };
  const boat = {
    id: 7,
    x: 100,
    y: 100,
    heading: 0,
    collisionRadius: 12,
    hull: 100,
    hullMax: 100,
    armor: 20,
    armorMax: 20,
    leak: 0,
    water: 0,
  };
  const instance = {
    zones: {
      aft: {health: 100, flooding: 0, fire: 0, leakRate: 0},
      engine: {health: 100, flooding: 0, fire: 0, leakRate: 0},
      cabin: {health: 100, flooding: 0, fire: 0, leakRate: 0},
    },
    modules: {
      helm: {health: 100, enabled: true},
      engine: {health: 100, enabled: true},
      pump: {health: 65, enabled: true},
      cargo: {health: 100, enabled: true},
    },
    occupants: {},
  };
  return {definition, boat, instance};
}

test("direct fire resolves the actual external hull compartment", () => {
  const entry = makeEntry();
  const front = resolveVesselImpactZone(entry, {
    impactPoint: {x: entry.boat.x, y: entry.boat.y},
    sourcePoint: {x: 100, y: 60},
  });
  const rear = resolveVesselImpactZone(entry, {
    impactPoint: {x: entry.boat.x, y: entry.boat.y},
    sourcePoint: {x: 100, y: 140},
  });
  const side = resolveVesselImpactZone(entry, {
    impactPoint: {x: entry.boat.x, y: entry.boat.y},
    sourcePoint: {x: 140, y: 100},
  });
  assert.equal(front.zoneId, "cabin");
  assert.equal(rear.zoneId, "aft");
  assert.equal(side.zoneId, "engine");
});

test("routed bullet damages one zone, its module, hull and zonal leak", () => {
  const entry = makeEntry();
  const result = applyRoutedVesselImpact(entry, {
    legacyHullDamage: 5,
    leak: 0.2,
    flooding: 2,
    impactPoint: {x: 100, y: 100},
    sourcePoint: {x: 100, y: 60},
  });
  assert.equal(result.zoneId, "cabin");
  assert.equal(result.moduleId, "helm");
  assert.equal(entry.boat.hull, 95);
  assert.equal(entry.instance.zones.cabin.health, 90);
  assert.equal(entry.instance.zones.cabin.flooding, 2);
  assert.equal(entry.instance.zones.cabin.leakRate, 0.2);
  assert.equal(entry.instance.modules.helm.health, 90);
  assert.equal(entry.instance.zones.engine.health, 100);
});

test("legacy gun hit is removed from global damage then reapplied to the hit compartment", () => {
  const entry = makeEntry();
  const world = {
    players: [{x: 100, y: 60}],
    events: [],
  };
  snapshotLegacyFrame({world, nativeVessels: [entry], eventStart: 0});
  entry.boat.hull = 98;
  entry.boat.leak = 0.06;
  const hit = {
    type: "gun-boat-hit",
    targetBoat: entry.boat.id,
    sourcePlayer: 0,
    weapon: "pistol",
    x: entry.boat.x,
    y: entry.boat.y,
    text: "legacy",
  };
  world.events.push(hit, {
    type: "gun-boat-damaged",
    targetBoat: entry.boat.id,
    sourcePlayer: 0,
    x: entry.boat.x,
    y: entry.boat.y,
    text: "legacy target",
  });
  captureLegacyBulletImpacts({world});
  assert.equal(entry.boat.hull, 100, "legacy hull loss is neutralized before old zonal translation");
  assert.equal(entry.boat.leak, 0, "legacy global leak is neutralized before old zonal translation");
  applyStagedBulletImpacts({world});
  assert.equal(entry.boat.hull, 98);
  assert.equal(entry.instance.zones.cabin.health, 96);
  assert.equal(entry.instance.modules.helm.health, 96);
  assert.equal(hit.zoneId, "cabin");
  assert.match(hit.text, /рубку/);
  assert.equal(world.events[1].zoneId, "cabin");
});

test("multiple physical bullet impacts in one frame can damage different compartments", () => {
  const entry = makeEntry();
  const world = {players: [], events: []};
  snapshotLegacyFrame({world, nativeVessels: [entry], eventStart: 0});
  entry.boat.hull = 94;
  entry.boat.leak = 0.28;
  world.events.push(
    {type: "enemy-bullet-boat-hit", targetBoat: 7, x: 100, y: 88, text: "legacy"},
    {type: "enemy-bullet-boat-hit", targetBoat: 7, x: 100, y: 112, text: "legacy"},
  );
  captureLegacyBulletImpacts({world});
  applyStagedBulletImpacts({world});
  assert.ok(entry.instance.zones.cabin.health < 100);
  assert.ok(entry.instance.zones.aft.health < 100);
  assert.equal(entry.instance.zones.engine.health, 100);
  assert.equal(entry.boat.hull, 94);
});

test("blast spreads one conserved hull-damage budget across nearby compartments", () => {
  const entry = makeEntry();
  const result = applyRoutedVesselBlast(entry, {
    legacyHullDamage: 30,
    leak: 3,
    flooding: 12,
    impactPoint: {x: 100, y: 100},
    blastRadius: 30,
  });
  assert.equal(result.mode, "zonal-blast");
  assert.equal(result.impacts.length, 3);
  assert.equal(entry.boat.hull, 70, "three compartments must not triple total hull damage");
  assert.ok(entry.instance.zones.engine.health < 100);
  assert.ok(entry.instance.zones.cabin.health < 100);
  assert.ok(entry.instance.zones.aft.health < 100);
  const leak = Object.values(entry.instance.zones).reduce((sum, zone) => sum + zone.leakRate, 0);
  assert.ok(Math.abs(leak - 3) < 1e-9);
});

test("external mega-bomb replay restores baseline then applies zonal blast immediately", () => {
  const entry = makeEntry();
  const event = {type: "mega-bomb-boat-hit", boatId: 7, text: "legacy bomb"};
  const world = {events: [event]};
  entry.boat.hull = 90;
  entry.boat.armor = 15;
  entry.boat.leak = 2;
  entry.boat.water = 10;
  queueExternalVesselImpact(world, {
    boatId: 7,
    baseline: {hull: 100, armor: 20, leak: 0, water: 0},
    event,
    armorDamage: 5,
    hullDamage: 10,
    leak: 2,
    flooding: 10,
    impactPoint: {x: 100, y: 100},
    blastRadius: 30,
  });
  applyExternalImpacts({world, nativeVessels: [entry]});
  assert.equal(entry.boat.hull, 90);
  assert.equal(entry.boat.armor, 15);
  assert.equal(event.vesselZonalImpact, true);
  assert.equal(event.affectedZoneIds.length, 3);
  assert.ok(entry.boat.water > 0);
  assert.ok(entry.boat.leak > 0);
});
