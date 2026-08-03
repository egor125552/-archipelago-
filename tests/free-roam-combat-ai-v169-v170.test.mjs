import test from "node:test";
import assert from "node:assert/strict";
import {restoreEngineDefensiveFireV169} from "../public/src/free-roam-combat-ai-model-v169.js";
import {
  recordAutomaticPressureV170,
  applyAutomaticSuppressionRetreatV170,
} from "../public/src/free-roam-combat-ai-model-v170.js";

function world() {
  const boat = {
    id: "heavy-pursuer",
    active: true,
    destroyed: false,
    x: 210,
    y: 200,
    heading: 0,
    speed: 0,
    hull: 180,
    maxHull: 260,
    engineHealth: 180,
    turretHealth: 240,
    turretDisabled: false,
    fireCooldown: 999,
    burstRemaining: 0,
    burstCooldown: 0,
    aimRemaining: 0,
    turretHeading: 0,
  };
  return {
    time: 20,
    events: [],
    players: [
      {x: 50, y: 90, mode: "foot", combat: {alive: true}},
      {x: 350, y: 280, mode: "foot", combat: {alive: true}},
    ],
    freeActivities: {presence: [true, true]},
    freeHeavyPursuer: {active: true, boat},
    freeCombatAiV164: {heavy: {phase: "combat", repairSystem: null}},
  };
}

function tacticalState() {
  return {
    automaticHits: [],
    newAutomaticHits: 0,
    phase: null,
    destination: null,
    sourcePlayer: null,
    minimumUntil: -999,
    regroupUntil: -999,
    retreatSerial: 0,
  };
}

function automaticHit(sourcePlayer = 0, at = 20) {
  return {type: "heavy-component-hit", weapon: "automatic", sourcePlayer, at};
}

test("destroyed engine keeps a healthy turret firing during repair", () => {
  const state = world();
  const boat = state.freeHeavyPursuer.boat;
  const heavy = state.freeCombatAiV164.heavy;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "engine";
  boat.engineHealth = 0;
  boat.turretDisabled = true;

  const restored = restoreEngineDefensiveFireV169(state, {
    fireCooldown: 0.4,
    burstRemaining: 7,
    burstCooldown: 0.05,
    aimRemaining: 0,
    turretHeading: 35,
  });

  assert.equal(restored, true);
  assert.equal(boat.turretDisabled, false);
  assert.equal(boat.fireCooldown, 0.4);
  assert.equal(boat.burstRemaining, 7);
  assert.equal(boat.turretHeading, 35);
});

test("destroyed turret cannot fire while the engine is repaired", () => {
  const state = world();
  const boat = state.freeHeavyPursuer.boat;
  const heavy = state.freeCombatAiV164.heavy;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "engine";
  boat.engineHealth = 0;
  boat.turretHealth = 0;
  boat.turretDisabled = true;

  assert.equal(restoreEngineDefensiveFireV169(state, {}), false);
  assert.equal(boat.turretDisabled, true);
});

test("destroyed hull stops defensive fire completely", () => {
  const state = world();
  const boat = state.freeHeavyPursuer.boat;
  const heavy = state.freeCombatAiV164.heavy;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "engine";
  boat.engineHealth = 0;
  boat.hull = 0;

  assert.equal(restoreEngineDefensiveFireV169(state, {}), false);
});

test("one or two automatic hits do not trigger a panic escape", () => {
  const state = world();
  const tactics = tacticalState();
  state.events.push(automaticHit(), automaticHit());
  recordAutomaticPressureV170(state, tactics, 0);
  applyAutomaticSuppressionRetreatV170(state, tactics, 0.2, {
    eventStart: 0,
    position: {...state.freeHeavyPursuer.boat},
  });

  assert.equal(tactics.phase, null);
  assert.equal(state.events.some(event => event.type === "heavy-automatic-suppression-escape-v170"), false);
});

test("three rapid automatic hits trigger an immediate full-speed escape", () => {
  const state = world();
  const tactics = tacticalState();
  const boat = state.freeHeavyPursuer.boat;
  const before = {x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed};
  state.events.push(automaticHit(), automaticHit(), automaticHit());
  recordAutomaticPressureV170(state, tactics, 0);
  applyAutomaticSuppressionRetreatV170(state, tactics, 0.2, {eventStart: 0, position: before});

  assert.equal(tactics.phase, "escape");
  assert.ok(boat.speed >= 11.5);
  assert.ok(Math.hypot(boat.x - before.x, boat.y - before.y) > 0);
  assert.equal(state.events.some(event => event.type === "heavy-automatic-suppression-escape-v170"), true);
});

test("widely separated hits do not combine into suppression", () => {
  const state = world();
  const tactics = tacticalState();
  state.events.push(automaticHit(0, 20));
  recordAutomaticPressureV170(state, tactics, 0);
  state.events = [];
  state.time = 22;
  state.events.push(automaticHit(0, 22), automaticHit(0, 22));
  recordAutomaticPressureV170(state, tactics, 0);
  applyAutomaticSuppressionRetreatV170(state, tactics, 0.2, {
    eventStart: 0,
    position: {...state.freeHeavyPursuer.boat},
  });

  assert.equal(tactics.phase, null);
});

test("a destroyed engine never receives a magical suppression escape", () => {
  const state = world();
  const tactics = tacticalState();
  const boat = state.freeHeavyPursuer.boat;
  boat.engineHealth = 0;
  state.events.push(automaticHit(), automaticHit(), automaticHit());
  recordAutomaticPressureV170(state, tactics, 0);
  applyAutomaticSuppressionRetreatV170(state, tactics, 0.2, {
    eventStart: 0,
    position: {...boat},
  });

  assert.equal(tactics.phase, null);
  assert.equal(boat.speed, 0);
});
