import test from "node:test";
import assert from "node:assert/strict";
import {prepareCombatAiV168Overlay, finishCombatAiV168Overlay} from "../public/src/free-roam-combat-ai-model-v168.js";

function world() {
  const boat = {
    id: "heavy-pursuer", role: "heavy", active: true, destroyed: false,
    x: 210, y: 200, heading: 0, speed: 0,
    hull: 180, maxHull: 260,
    engineHealth: 180, maxEngineHealth: 180,
    turretHealth: 240, maxTurretHealth: 240,
    engineDisabled: false, turretDisabled: false, fireCooldown: 4,
  };
  return {
    time: 20,
    events: [],
    players: [
      {x: 200, y: 120, heading: 0, mode: "foot", combat: {alive: true, ammo: 60, pistolAmmo: 20, megaBombStock: 1}},
      {x: 350, y: 280, heading: 180, mode: "foot", combat: {alive: true, ammo: 0, pistolAmmo: 0, megaBombStock: 0}},
    ],
    freeActivities: {presence: [true, true]},
    freeHeavyPursuer: {active: true, boat},
    freeCombatAiV164: {heavy: {phase: "combat", armourBreached: true, lastDamageAt: -999, repairProgress: 0}},
    freeMegaBombs: {projectiles: []},
  };
}

function tick(state, dt = 0.2, events = []) {
  prepareCombatAiV168Overlay(state);
  state.events.push(...events);
  finishCombatAiV168Overlay(state, dt);
  state.time += dt;
}

test("armed player makes the boss open distance and keep the turret available", () => {
  const state = world();
  const boat = state.freeHeavyPursuer.boat;
  const before = Math.hypot(boat.x - state.players[0].x, boat.y - state.players[0].y);
  for (let index = 0; index < 15; index += 1) tick(state);
  const after = Math.hypot(boat.x - state.players[0].x, boat.y - state.players[0].y);
  assert.ok(after > before);
  assert.equal(boat.targetPlayer, 0);
  assert.equal(boat.turretDisabled, false);
  assert.equal(state.freeCombatAiV168.mode, "standoff");
});

test("zero ammo is not read telepathically", () => {
  const state = world();
  state.players[0].combat.ammo = 0;
  state.players[0].combat.pistolAmmo = 0;
  state.players[0].combat.megaBombStock = 0;
  state.players[1].combat.alive = false;
  tick(state);
  assert.equal(state.freeCombatAiV168.mode, "standoff");
});

test("observed empty weapons make the boss approach cautiously", () => {
  const state = world();
  state.players[1].combat.alive = false;
  state.players[0].x = 20;
  state.players[0].y = 90;
  tick(state, 0.2, [{type: "gun-empty", sourcePlayer: 0, weapon: "automatic", text: "Патроны автомата закончились."}]);
  state.time += 1.6;
  const boat = state.freeHeavyPursuer.boat;
  const before = Math.hypot(boat.x - state.players[0].x, boat.y - state.players[0].y);
  tick(state, 0.2, [{type: "gun-empty", targets: [0], weapon: "pistol", text: "Патроны пистолета закончились."}]);
  for (let index = 0; index < 15; index += 1) tick(state);
  const after = Math.hypot(boat.x - state.players[0].x, boat.y - state.players[0].y);
  assert.ok(after < before);
  assert.equal(state.freeCombatAiV168.mode, "press-unarmed");
});

test("a new shot cancels the unarmed assumption", () => {
  const state = world();
  state.players[1].combat.alive = false;
  tick(state, 0.2, [{type: "gun-empty", sourcePlayer: 0, weapon: "automatic", text: "Патроны автомата закончились."}]);
  state.time += 1.6;
  tick(state, 0.2, [{type: "gun-empty", sourcePlayer: 0, weapon: "pistol", text: "Патроны пистолета закончились."}]);
  state.time += 1.6;
  tick(state, 0.2, [{type: "gun-shot", sourcePlayer: 0, weapon: "pistol"}]);
  assert.notEqual(state.freeCombatAiV168.mode, "press-unarmed");
});

test("swimmer becomes the priority and triggers aggressive closing", () => {
  const state = world();
  state.players[1].mode = "swim";
  state.players[1].x = 390;
  state.players[1].y = 290;
  tick(state);
  assert.equal(state.freeHeavyPursuer.boat.targetPlayer, 1);
  assert.equal(state.freeCombatAiV168.mode, "hunt-swimmer");
});

test("repair is aborted when a pursuer is inside mega-bomb clearance", () => {
  const state = world();
  const heavy = state.freeCombatAiV164.heavy;
  const boat = state.freeHeavyPursuer.boat;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "turret";
  heavy.repairProgress = 6;
  state.players[0].x = boat.x + 60;
  state.players[0].y = boat.y;
  tick(state);
  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.ok(heavy.repairProgress < 6);
  assert.ok(heavy.destination);
  assert.deepEqual(heavy.v167ReachableDestination, heavy.destination);
  assert.equal(state.events.some(event => event.type === "heavy-tactical-mode-v168" && event.mode === "repair-aborted"), true);
});

test("destroyed engine does not produce a magical escape", () => {
  const state = world();
  const heavy = state.freeCombatAiV164.heavy;
  const boat = state.freeHeavyPursuer.boat;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "engine";
  heavy.repairProgress = 2;
  boat.engineHealth = 0;
  boat.engineDisabled = true;
  tick(state);
  assert.equal(heavy.phase, "breach-repairing-v166");
  assert.equal(boat.speed, 0);
});

test("incoming bomb interrupts a stationary repair", () => {
  const state = world();
  const heavy = state.freeCombatAiV164.heavy;
  const boat = state.freeHeavyPursuer.boat;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "turret";
  heavy.repairProgress = 4;
  state.players[0].x = 18;
  state.players[0].y = 88;
  state.players[1].combat.alive = false;
  state.freeMegaBombs.projectiles.push({age: 0.4, maxAge: 6, energy: 1, targetId: "heavy-pursuer", x: 100, y: 100});
  tick(state);
  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.equal(state.events.some(event => event.mode === "repair-aborted"), true);
});
