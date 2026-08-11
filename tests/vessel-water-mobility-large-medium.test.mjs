import test from "node:test";
import assert from "node:assert/strict";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {installCoreVesselModuleTypes} from "../public/src/vessel/modules/core-module-types.js";
import {installMediumCrewVesselType} from "../public/src/vessel/definitions/medium-crew-vessel-v2.js?v=2";
import {
  adjustVesselZoneWater,
  vesselOccupantWaterState,
} from "../public/src/vessel/vessel-deck-runtime.js";
import {VESSEL_WATER_MOBILITY_SYSTEMS} from "../public/src/vessel/systems/vessel-water-mobility-system.js?v=1";

function fixture() {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  installCoreVesselModuleTypes(registry);
  installMediumCrewVesselType(registry);
  const definition = registry.resolveVesselType("medium-crew-vessel");
  const instance = registry.createInstance(definition.id, {
    instanceId: "medium:water-test",
    state: definition.runtimeDefaults,
  });
  const boat = {
    ...definition.runtimeDefaults,
    id: 4,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    x: 210,
    y: 92,
    heading: 0,
    owner: 0,
    driver: null,
    crew: [0],
  };
  const world = {
    time: 10,
    boats: [null, null, null, null, boat],
    players: [{
      mode: "boat",
      activeBoat: 4,
      x: 210,
      y: 92,
      heading: 0,
      running: false,
      combat: {alive: true, health: 100},
    }],
    events: [],
  };
  const entry = {definition, instance, boat};
  instance.occupants["0"] = {
    deckId: "medium-aft-deck",
    zoneId: "medium-aft-zone",
    x: 0,
    y: -6,
    heading: 0,
    mode: "walking",
  };
  return {registry, definition, instance, boat, world, entry};
}

function coordinate(point, axis) {
  if (Array.isArray(point)) return Number(point[axis === "x" ? 0 : 1]);
  return Number(point?.[axis]);
}

function span(deck, axis) {
  const values = deck.shape.outer.map(point => coordinate(point, axis));
  return Math.max(...values) - Math.min(...values);
}

function floodingForMode(definition, instance, zoneId, playerIndex, wantedMode) {
  for (let amount = 1; amount <= 100; amount += 1) {
    instance.zones[zoneId].flooding = amount;
    if (vesselOccupantWaterState(definition, instance, playerIndex).mode === wantedMode) return amount;
  }
  throw new Error(`unable to find flooding amount for ${wantedMode}`);
}

test("medium crew vessel v2 provides genuinely large walkable compartments and generous interaction ranges", () => {
  const {definition} = fixture();
  const aft = definition.decks.find(deck => deck.id === "medium-aft-deck");
  const cabin = definition.decks.find(deck => deck.id === "medium-cabin-deck");
  const engine = definition.decks.find(deck => deck.id === "medium-engine-deck");

  assert.ok(span(aft, "x") >= 14);
  assert.ok(span(aft, "y") >= 12);
  assert.ok(span(cabin, "x") >= 12);
  assert.ok(span(cabin, "y") >= 12);
  assert.ok(span(engine, "x") >= 12);
  assert.ok(span(engine, "y") >= 12);
  assert.ok(definition.runtimeDefaults.collisionRadius >= 13);

  const interactive = definition.decks.flatMap(deck => [
    ...(deck.objects || []).filter(object => object.kind === "station"),
    ...(deck.connections || []),
  ]);
  assert.ok(interactive.length >= 8);
  assert.ok(interactive.every(entity => Number(entity.interactionRange) >= 3));

  const boarding = definition.deckArchitecture.boarding.points.find(point => point.id === "medium-aft-entry");
  assert.ok(Math.abs(coordinate(boarding.position, "y")) >= 10);
});

test("deep compartment flooding turns walking into swimming instead of cosmetic percentages", () => {
  const {definition, instance, world, entry} = fixture();
  adjustVesselZoneWater(definition, instance, "medium-aft-zone", 80);

  const beforeInput = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.phase === "before-input");
  const capture = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("capture-after-step"));
  const apply = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("apply-after-step"));
  const input = {up: true, run: true, jump: true};

  beforeInput.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(input.run, false, "running must be disabled once the player is swimming");
  assert.equal(input.jump, false, "deck jumping must be disabled while swimming");

  capture.run({world, nativeVessels: [entry]});
  instance.occupants["0"].y += 1;
  world.events.push({
    type: "footstep",
    sourcePlayer: 0,
    boatId: 4,
    vesselDeck: true,
    targets: [0],
    at: world.time,
  });
  apply.run({world, nativeVessels: [entry]});

  const travelled = instance.occupants["0"].y - (-6);
  assert.ok(travelled > 0.25 && travelled < 0.45, `swimming drag should reduce movement, got ${travelled}`);
  assert.equal(world.players[0].vesselWaterMode, "swimming");
  assert.equal(world.events.find(event => event.vesselDeckWater === true)?.type, "splash");
  assert.ok(world.events.some(event => event.type === "vessel-water-mobility" && /плыть/.test(event.text)));
});

test("pumping from wading down to ankle depth announces improvement, not worsening", () => {
  const {definition, instance, world, entry} = fixture();
  const capture = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("capture-after-step"));
  const apply = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("apply-after-step"));
  const zoneId = "medium-aft-zone";
  const wading = floodingForMode(definition, instance, zoneId, 0, "wading");
  const ankle = floodingForMode(definition, instance, zoneId, 0, "ankle");
  assert.ok(ankle < wading, "ankle water must be shallower than wading water");

  instance.zones[zoneId].flooding = wading;
  capture.run({world, nativeVessels: [entry]});
  apply.run({world, nativeVessels: [entry]});
  assert.equal(world.players[0].vesselWaterMode, "wading");

  world.events = [];
  world.time += 1;
  instance.zones[zoneId].flooding = ankle;
  capture.run({world, nativeVessels: [entry]});
  apply.run({world, nativeVessels: [entry]});

  const event = world.events.find(candidate => candidate.type === "vessel-water-mobility");
  assert.ok(event, "crossing down into ankle depth must be announced once");
  assert.equal(event.previousWaterMode, "wading");
  assert.equal(event.waterMode, "ankle");
  assert.equal(event.waterTrend, "falling");
  assert.match(event.text, /опустилась до щиколоток/i);
  assert.match(event.text, /становится легче/i);
  assert.doesNotMatch(event.text, /становится тяжелее/i);
});

test("a dry compartment keeps normal deck movement and controls", () => {
  const {instance, world, entry} = fixture();
  const beforeInput = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.phase === "before-input");
  const capture = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("capture-after-step"));
  const apply = VESSEL_WATER_MOBILITY_SYSTEMS.find(system => system.id.includes("apply-after-step"));
  const input = {up: true, run: true, jump: true};

  beforeInput.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(input.run, true);
  assert.equal(input.jump, true);

  capture.run({world, nativeVessels: [entry]});
  instance.occupants["0"].y += 1;
  apply.run({world, nativeVessels: [entry]});

  assert.equal(instance.occupants["0"].y, -5);
  assert.equal(world.players[0].vesselWaterMode, "dry");
});
