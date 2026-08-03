import test from "node:test";
import assert from "node:assert/strict";
import {
  MEGA_BOMB_RANGE,
  preserveLongRangeTargetV172,
  stabilizeTurretRecoveryV172,
  suppressOutOfRangeDirectFireV172,
} from "../public/src/free-roam-combat-ai-model-v172.js";
import {
  activeEntitySnapshots,
  collectionValues,
} from "../public/src/free-roam-developer-log-model-v2.js";

function combatWorld({targetX = 235, targetId = "heavy-pursuer", attack = false} = {}) {
  const input = {targetId, attack};
  return {
    time: 100,
    events: [],
    players: [{
      x: 0,
      y: 0,
      mode: "foot",
      combat: {alive: true, equipped: "automatic", lockedTargetId: null, lastTargetRequestId: targetId},
    }],
    boats: [],
    freeActivities: {presence: [true], inputs: [input]},
    inputs: [input],
    operationInputs: [input],
    freeHeavyPursuer: {
      active: true,
      encounterId: 7,
      boat: {
        id: "heavy-pursuer", role: "heavy", x: targetX, y: 0, heading: 0, speed: 0,
        hull: 700, maxHull: 700, engineHealth: 180, maxEngineHealth: 180,
        turretHealth: 240, maxTurretHealth: 240, active: true, destroyed: false, targetPlayer: 0,
      },
    },
  };
}

function v172State() {
  return {repairEncounterId: null, stableRepairDestination: null, targetLocks: {}, lastOutOfRangeFireAt: {}};
}

test("alive target between automatic and mega-bomb ranges stays locked", () => {
  const world = combatWorld({targetX: 235});
  world.events.push({type: "target-lost", text: "Эта цель уже недоступна.", targets: [0], sourcePlayer: 0});
  preserveLongRangeTargetV172(world, v172State(), 0);
  assert.equal(world.players[0].combat.lockedTargetId, "heavy-pursuer");
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
  assert.equal(world.events.some(event => event.type === "target-locked-long-range-v172"), true);
});

test("alive target beyond mega-bomb range gets an accurate distance message", () => {
  const world = combatWorld({targetX: MEGA_BOMB_RANGE + 35});
  world.events.push({type: "target-lost", text: "Эта цель уже недоступна.", targets: [0], sourcePlayer: 0});
  preserveLongRangeTargetV172(world, v172State(), 0);
  assert.equal(world.players[0].combat.lockedTargetId, null);
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
  const report = world.events.find(event => event.type === "target-alive-out-of-range-v172");
  assert.ok(report);
  assert.ok(report.text.includes("Цель жива"));
  assert.ok(report.text.includes(String(MEGA_BOMB_RANGE)));
});

test("destroyed target keeps the original unavailable result", () => {
  const world = combatWorld({targetX: 235});
  world.freeHeavyPursuer.boat.active = false;
  world.freeHeavyPursuer.boat.destroyed = true;
  world.events.push({type: "target-lost", text: "Эта цель уже недоступна.", targets: [0], sourcePlayer: 0});
  preserveLongRangeTargetV172(world, v172State(), 0);
  assert.equal(world.players[0].combat.lockedTargetId, null);
  assert.equal(world.events.some(event => event.type === "target-lost"), true);
});

test("automatic fire is suppressed while selected target is out of direct range", () => {
  const world = combatWorld({targetX: 235, attack: true});
  const saved = suppressOutOfRangeDirectFireV172(world, v172State());
  assert.equal(world.freeActivities.inputs[0].attack, false);
  assert.equal(saved.length, 1);
  saved[0].input.attack = saved[0].attack;
  assert.equal(world.freeActivities.inputs[0].attack, true);
});

function repairWorld() {
  const boat = {
    id: "heavy-pursuer", active: true, destroyed: false, x: 210, y: 200, heading: 0, speed: 0,
    hull: 260, maxHull: 260, engineHealth: 180, maxEngineHealth: 180,
    turretHealth: 0, maxTurretHealth: 240,
  };
  return {
    time: 200,
    events: [],
    players: [{x: 200, y: 200, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, encounterId: 8, boat},
    freeCombatAiV164: {heavy: {
      encounterId: 8, phase: "breach-escaping-v166", repairSystem: "turret",
      repairProgress: 0, repairPlates: 3, destination: {x: 404, y: 308},
    }},
    freeMegaBombs: {projectiles: []},
  };
}

test("turret repair uses one stable route and begins when that route is safe", () => {
  const world = repairWorld();
  const state = v172State();
  stabilizeTurretRecoveryV172(world, state, 0);
  const first = {...state.stableRepairDestination};
  assert.ok(first.x != null && first.y != null);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-escaping-v166");
  world.freeCombatAiV164.heavy.destination = {x: 16, y: 86};
  world.freeCombatAiV164.heavy.v168SafeDestination = {x: 16, y: 86};
  world.time += 0.05;
  stabilizeTurretRecoveryV172(world, state, 0);
  assert.deepEqual(state.stableRepairDestination, first);
  assert.deepEqual(world.freeCombatAiV164.heavy.destination, first);
  Object.assign(world.freeHeavyPursuer.boat, first);
  world.time += 1;
  stabilizeTurretRecoveryV172(world, state, 0);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-repairing-v166");
  assert.equal(world.freeHeavyPursuer.boat.speed, 0);
  assert.equal(world.events.some(event => event.type === "heavy-turret-repair-safe-v172"), true);
});

test("logger accepts object-mapped replicated collections", () => {
  const world = {
    players: {0: {x: 1, y: 2, combat: {alive: true}}}, boats: {},
    freeActivities: {presence: {0: true}, marauder: null},
    freePursuerSquad: {escorts: {}}, freeEnemyBoats: {boats: {}},
    freeHostileGunners: {gunners: {}},
    freeHostileActors: {actors: {one: {
      id: "actor-1", active: true, destroyed: false, x: 5, y: 6, health: 40, weapon: "automatic",
    }}},
  };
  assert.deepEqual(collectionValues({a: 1, b: 2}), [1, 2]);
  const snapshots = activeEntitySnapshots(world);
  assert.equal(snapshots.some(item => item.id === "actor-1"), true);
});
