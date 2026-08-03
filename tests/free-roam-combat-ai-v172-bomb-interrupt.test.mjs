import test from "node:test";
import assert from "node:assert/strict";
import {stabilizeTurretRecoveryV172} from "../public/src/free-roam-combat-ai-model-v172.js";

test("real incoming mega-bomb prevents turret repair even at safe direct-fire distance", () => {
  const world = {
    time: 4,
    events: [],
    players: [{x: 20, y: 100, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, encounterId: 2, boat: {id: "heavy-pursuer", active: true, destroyed: false, x: 380, y: 300, speed: 0, hull: 260, engineHealth: 180, turretHealth: 0}},
    freeCombatAiV164: {heavy: {encounterId: 2, phase: "breach-repairing-v166", repairSystem: "turret", repairProgress: 3, repairPlates: 3}},
    freeMegaBombs: {projectiles: [{id: "bomb-1", energy: 1, ttl: 3, age: 1, maxAge: 6, targetId: "heavy-turret", x: 200, y: 200}]},
  };
  const state = {repairEncounterId: null, stableRepairDestination: null, targetLocks: {}, lastOutOfRangeFireAt: {}};
  stabilizeTurretRecoveryV172(world, state, 0);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-escaping-v166");
  assert.ok(world.freeHeavyPursuer.boat.speed >= 7.2);
});
