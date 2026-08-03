import test from "node:test";
import assert from "node:assert/strict";
import {stabilizeTurretRecoveryV172} from "../public/src/free-roam-combat-ai-model-v172.js";

test("V172 does not give movement to a heavy boat with a destroyed engine", () => {
  const world = {
    time: 5,
    events: [],
    players: [{x: 210, y: 200, mode: "foot", combat: {alive: true}}],
    boats: [], freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, encounterId: 3, boat: {id: "heavy-pursuer", active: true, destroyed: false, x: 210, y: 200, speed: 0, hull: 260, engineHealth: 0, turretHealth: 0}},
    freeCombatAiV164: {heavy: {encounterId: 3, phase: "breach-stopping-v166", repairSystem: "engine", repairProgress: 0, repairPlates: 3}},
    freeMegaBombs: {projectiles: []},
  };
  const state = {repairEncounterId: null, stableRepairDestination: null, targetLocks: {}, lastOutOfRangeFireAt: {}};
  assert.equal(stabilizeTurretRecoveryV172(world, state, 0), false);
  assert.equal(world.freeHeavyPursuer.boat.speed, 0);
});
