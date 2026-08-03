import test from "node:test";
import assert from "node:assert/strict";
import {stabilizeTurretRecoveryV172} from "../public/src/free-roam-combat-ai-model-v172.js";

test("real-log regression: moving turretless heavy keeps one route instead of endless rerouting", () => {
  const world = {
    time: 5494.6,
    events: [],
    players: [{x: 210, y: 105, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, encounterId: 11, boat: {
      id: "heavy-pursuer", active: true, destroyed: false,
      x: 200, y: 200, heading: 0, speed: 13.4,
      hull: 697.81, engineHealth: 175.13, turretHealth: 0,
    }},
    freeCombatAiV164: {heavy: {
      encounterId: 11, phase: "breach-escaping-v166", repairSystem: "turret",
      repairProgress: 0, repairPlates: 3, destination: {x: 404, y: 308},
    }},
    freeMegaBombs: {projectiles: []},
  };
  const state = {repairEncounterId: null, stableRepairDestination: null, targetLocks: {}, lastOutOfRangeFireAt: {}};
  stabilizeTurretRecoveryV172(world, state, 0);
  const selected = {...state.stableRepairDestination};
  for (let tick = 0; tick < 100; tick += 1) {
    world.time += 0.05;
    world.freeCombatAiV164.heavy.destination = {x: tick % 2 ? 16 : 404, y: tick % 2 ? 86 : 308};
    stabilizeTurretRecoveryV172(world, state, world.events.length);
    assert.deepEqual(world.freeCombatAiV164.heavy.destination, selected);
  }
});
