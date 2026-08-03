import test from "node:test";
import assert from "node:assert/strict";
import {stabilizeTurretRecoveryV172} from "../public/src/free-roam-combat-ai-model-v172.js";

test("repair route remains inside physical heavy-boat bounds", () => {
  const world = {
    time: 3,
    events: [],
    players: [{x: 400, y: 300, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, encounterId: 1, boat: {id: "heavy-pursuer", active: true, destroyed: false, x: 390, y: 300, speed: 13.4, hull: 260, engineHealth: 180, turretHealth: 0}},
    freeCombatAiV164: {heavy: {encounterId: 1, phase: "breach-escaping-v166", repairSystem: "turret", repairProgress: 0, repairPlates: 3}},
    freeMegaBombs: {projectiles: []},
  };
  const state = {repairEncounterId: null, stableRepairDestination: null, targetLocks: {}, lastOutOfRangeFireAt: {}};
  stabilizeTurretRecoveryV172(world, state, 0);
  assert.ok(state.stableRepairDestination.x >= 16 && state.stableRepairDestination.x <= 404);
  assert.ok(state.stableRepairDestination.y >= 86 && state.stableRepairDestination.y <= 308);
});
