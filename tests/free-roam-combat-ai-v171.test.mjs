import test from "node:test";
import assert from "node:assert/strict";
import {
  TURRET_REPAIR_CLEARANCE_V171,
  achievableTurretRepairClearanceV171,
  stabilizeTurretRepairV171,
} from "../public/src/free-roam-combat-ai-model-v171.js";

function world({playerX = 210, playerY = 200, boatX = 404, boatY = 308} = {}) {
  const boat = {
    id: "heavy-pursuer",
    active: true,
    destroyed: false,
    x: boatX,
    y: boatY,
    heading: 0,
    speed: 0,
    hull: 160,
    maxHull: 260,
    engineHealth: 180,
    maxEngineHealth: 180,
    turretHealth: 0,
    maxTurretHealth: 240,
  };
  return {
    time: 30,
    events: [],
    players: [{x: playerX, y: playerY, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeHeavyPursuer: {active: true, boat},
    freeCombatAiV164: {heavy: {
      phase: "breach-escaping-v166",
      repairSystem: "turret",
      repairProgress: 0.7,
      destination: {x: 404, y: 308},
    }},
    freeCombatAiV168: {mode: "repair-aborted"},
    freeMegaBombs: {projectiles: []},
  };
}

function tacticalState() {
  return {retreatSerial: 0, lastForcedEscapeAt: -999};
}

test("ordinary turret repair clearance is based on automatic range, not mega-bomb range", () => {
  const state = world({playerX: 40, playerY: 90});
  assert.ok(achievableTurretRepairClearanceV171(state) <= TURRET_REPAIR_CLEARANCE_V171);
  assert.equal(TURRET_REPAIR_CLEARANCE_V171, 232);
});

test("an incorrectly aborted turret repair resumes when already outside automatic range", () => {
  const state = world({playerX: 40, playerY: 90, boatX: 404, boatY: 308});
  const heavy = state.freeCombatAiV164.heavy;
  const frame = {
    eventStart: 0,
    phase: "breach-repairing-v166",
    repairProgress: 2.4,
    position: {x: 404, y: 308},
  };
  state.events.push({type: "heavy-tactical-mode-v168", mode: "repair-aborted", at: state.time});

  const applied = stabilizeTurretRepairV171(state, tacticalState(), 0.2, frame);

  assert.equal(applied, true);
  assert.equal(heavy.phase, "breach-repairing-v166");
  assert.ok(heavy.repairProgress >= 2.4);
  assert.equal(state.freeHeavyPursuer.boat.speed, 0);
  assert.equal(state.events.some(event => event.mode === "repair-aborted"), false);
});

test("a turretless heavy boat with a healthy engine physically escapes a close player", () => {
  const state = world({playerX: 200, playerY: 200, boatX: 210, boatY: 200});
  const heavy = state.freeCombatAiV164.heavy;
  heavy.phase = "breach-repairing-v166";
  const boat = state.freeHeavyPursuer.boat;
  const before = {x: boat.x, y: boat.y};

  const applied = stabilizeTurretRepairV171(state, tacticalState(), 0.25, {
    eventStart: 0,
    phase: "breach-repairing-v166",
    repairProgress: 1.5,
    position: before,
  });

  assert.equal(applied, true);
  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.ok(boat.speed >= 7.2);
  assert.ok(Math.hypot(boat.x - before.x, boat.y - before.y) > 0);
  assert.ok(heavy.destination);
  assert.equal(state.events.some(event => event.type === "heavy-turret-repair-escape-v171"), true);
});

test("a destroyed engine still cannot receive a magical repair escape", () => {
  const state = world({playerX: 200, playerY: 200, boatX: 210, boatY: 200});
  const boat = state.freeHeavyPursuer.boat;
  boat.engineHealth = 0;
  state.freeCombatAiV164.heavy.phase = "breach-repairing-v166";

  const applied = stabilizeTurretRepairV171(state, tacticalState(), 0.25, {
    eventStart: 0,
    phase: "breach-repairing-v166",
    repairProgress: 1,
    position: {x: boat.x, y: boat.y},
  });

  assert.equal(applied, false);
  assert.equal(boat.speed, 0);
});

test("an incoming mega-bomb still interrupts a distant turret repair", () => {
  const state = world({playerX: 40, playerY: 90, boatX: 404, boatY: 308});
  const boat = state.freeHeavyPursuer.boat;
  state.freeCombatAiV164.heavy.phase = "breach-repairing-v166";
  state.freeMegaBombs.projectiles.push({
    id: "bomb-1",
    targetId: "heavy-pursuer",
    x: 100,
    y: 100,
    energy: 1,
    ttl: 4,
    age: 0,
    maxAge: 6,
  });

  stabilizeTurretRepairV171(state, tacticalState(), 0.2, {
    eventStart: 0,
    phase: "breach-repairing-v166",
    repairProgress: 2,
    position: {x: boat.x, y: boat.y},
  });

  assert.equal(state.freeCombatAiV164.heavy.phase, "breach-escaping-v166");
  assert.ok(boat.speed >= 7.2);
  assert.equal(state.events.some(event => event.type === "heavy-turret-repair-escape-v171"), true);
});
