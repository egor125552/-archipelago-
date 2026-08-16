import test from "node:test";
import assert from "node:assert/strict";

import {ensureCombat} from "../public/src/free-roam-combat-v2.js";
import {CURRENT_VESSEL_TYPES} from "../public/src/vessel/definitions/current-vessels.js";
import {STRESS_TEST_VESSEL_SYSTEMS} from "../public/src/vessel/systems/stress-test-vessel-system.js";
import {VESSEL_MOUNTED_WEAPON_SYSTEMS} from "../public/src/vessel/systems/vessel-mounted-weapon-system.js";
import {STRESS_TEST_VESSEL_TYPE} from "../public/src/vessel/stress-test-vessel-config.js";

function liveContext() {
  const definition = CURRENT_VESSEL_TYPES.find(candidate => candidate.id === STRESS_TEST_VESSEL_TYPE);
  assert.ok(definition);
  const pistol = definition.modules.find(module => module.id === "stress-pistol");
  assert.equal(pistol.config.runtimeSystem, "station-hitscan-v1");

  const boat = {
    id: 0,
    boatType: STRESS_TEST_VESSEL_TYPE,
    vesselType: STRESS_TEST_VESSEL_TYPE,
    audioProfile: "stress-test-50",
    x: 100,
    y: 100,
    heading: 0,
    sunk: false,
    reserved: false,
    testWeaponAmmo: 100,
  };
  const world = {
    time: 10,
    boats: [boat],
    events: [],
    players: [
      {x: 100, y: 100, heading: 0, mode: "boat", activeBoat: 0},
      {x: 100, y: 340, heading: 180, mode: "foot", activeBoat: null},
    ],
    freeActivities: {presence: [true, true], inputs: [{}, {}]},
    operationInputs: [{}, {}],
    inputs: [{}, {}],
  };
  ensureCombat(world);
  world.players[0].combat.lockedTargetId = "player-1";
  const entry = {
    definition,
    boat,
    instance: {
      modules: {"stress-pistol": {enabled: true, health: 100, ammo: 100, cooldown: 0}},
      occupants: {0: {deckId: "stress-control-deck", x: 1.15, y: 1.15}},
      interior: {
        claims: {"stress-pistol-control": 0},
        walkableControl: {inputs: {"0": {attack: true}}},
      },
    },
  };
  return {world, entry};
}

test("stress pistol has only the shared firing authority", () => {
  assert.equal(STRESS_TEST_VESSEL_SYSTEMS.some(system => system.id.includes("mounted-pistol")), false);
});

test("real far stress-pistol shot uses distance falloff once", () => {
  const {world, entry} = liveContext();
  const before = [...STRESS_TEST_VESSEL_SYSTEMS, ...VESSEL_MOUNTED_WEAPON_SYSTEMS]
    .filter(system => system.phase === "before-step")
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  for (const system of before) system.run({world, dt: 0.04, eventStart: 0, nativeVessels: [entry]});

  const after = STRESS_TEST_VESSEL_SYSTEMS
    .filter(system => system.phase === "after-step")
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  for (const system of after) system.run({world, dt: 0.04, eventStart: 0, nativeVessels: [entry]});

  const shots = world.events.filter(event => event.type === "vessel-mounted-shot");
  assert.equal(shots.length, 1);
  assert.equal(shots[0].targetId, "player-1");
  assert.equal(shots[0].hit, true);
  assert.equal(shots[0].applied, true);
  assert.equal(shots[0].damage, 1.2);
  assert.equal(world.players[1].combat.health, 98.8);
  assert.equal(entry.instance.modules["stress-pistol"].ammo, 99);
  assert.equal(entry.boat.testWeaponAmmo, 99);
});
