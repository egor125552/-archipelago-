import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareCombatAiV166Overlay,
  finishCombatAiV166Overlay,
} from "../public/src/free-roam-combat-ai-model-v166.js";

function worldWithHeavy() {
  const boat = {
    id: "heavy-pursuer",
    role: "heavy",
    active: true,
    destroyed: false,
    x: 250,
    y: 210,
    heading: 0,
    speed: 0,
    hull: 260,
    maxHull: 260,
    engineHealth: 180,
    maxEngineHealth: 180,
    turretHealth: 240,
    maxTurretHealth: 240,
    engineDisabled: false,
    turretDisabled: false,
    fireCooldown: 0,
    burstRemaining: 3,
    aimRemaining: 1,
  };
  return {
    time: 20,
    events: [],
    players: [
      {x: 80, y: 110, combat: {alive: true}},
      {x: 320, y: 280, combat: {alive: true}},
    ],
    freeActivities: {presence: [true, true]},
    freeHeavyPursuer: {boat, active: true},
    freeCombatAiV164: {
      heavy: {
        phase: "combat",
        armourBreached: false,
        combatPoint: {x: 250, y: 210},
        repairPlates: 3,
        repairSystem: null,
        repairProgress: 0,
        repairQuarter: 0,
        lastDamageAt: -999,
        actualEngineDisabled: false,
        actualTurretDisabled: false,
      },
    },
  };
}

function tickOverlay(world, seconds, step = 0.1) {
  const count = Math.ceil(seconds / step);
  for (let index = 0; index < count; index += 1) {
    prepareCombatAiV166Overlay(world);
    finishCombatAiV166Overlay(world, step);
    world.time += step;
  }
}

test("armour destruction starts a physical full-throttle escape", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  prepareCombatAiV166Overlay(world);
  heavy.armourBreached = true;
  world.events.push({type: "heavy-armour-breached", targets: [0, 1], x: boat.x, y: boat.y});
  finishCombatAiV166Overlay(world, 0.2);

  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.ok(boat.speed > 0);
  assert.equal(boat.burstRemaining, 0);
  assert.equal(world.events.some(event => event.type === "heavy-breach-escape-v166"), true);
});

test("destroyed exposed turret triggers retreat and repair", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  heavy.armourBreached = true;
  prepareCombatAiV166Overlay(world);
  boat.turretHealth = 0;
  boat.turretDisabled = true;
  finishCombatAiV166Overlay(world, 0.1);

  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.equal(heavy.repairSystem, "turret");
  assert.equal(world.events.some(event => event.type === "heavy-system-recovery-v166"), true);
});

test("exposed turret repair consumes a plate and restores the system", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  heavy.armourBreached = true;
  heavy.phase = "breach-repairing-v166";
  heavy.repairSystem = "turret";
  heavy.repairProgress = 11.95;
  heavy.lastDamageAt = 0;
  boat.turretHealth = 0;
  boat.turretDisabled = true;

  prepareCombatAiV166Overlay(world);
  finishCombatAiV166Overlay(world, 0.1);

  assert.equal(heavy.phase, "breach-returning-v166");
  assert.equal(heavy.repairPlates, 2);
  assert.ok(boat.turretHealth > 0);
  assert.equal(boat.turretDisabled, false);
  assert.equal(world.events.some(event => event.type === "heavy-repair-complete-v166"), true);
});

test("destroyed exposed engine coasts to a stop before repairing", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  heavy.armourBreached = true;
  boat.speed = 8;
  prepareCombatAiV166Overlay(world);
  boat.engineHealth = 0;
  boat.engineDisabled = true;
  finishCombatAiV166Overlay(world, 0.1);

  assert.equal(heavy.phase, "breach-stopping-v166");
  assert.ok(boat.speed > 0);
  tickOverlay(world, 2);
  assert.equal(heavy.phase, "breach-repairing-v166");
  assert.equal(boat.speed, 0);
  assert.equal(heavy.repairSystem, "engine");
});

test("pre-breach destroyed turret also has a repair fallback", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  prepareCombatAiV166Overlay(world);
  boat.turretHealth = 0;
  boat.turretDisabled = true;
  finishCombatAiV166Overlay(world, 0.1);

  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.equal(heavy.repairSystem, "turret");
});

test("turret destroyed during the armour-breach escape is still repaired", () => {
  const world = worldWithHeavy();
  const boat = world.freeHeavyPursuer.boat;
  const heavy = world.freeCombatAiV164.heavy;
  heavy.armourBreached = true;
  heavy.phase = "breach-escaping-v166";
  heavy.destination = {x: 392, y: 286};
  prepareCombatAiV166Overlay(world);
  boat.turretHealth = 0;
  boat.turretDisabled = true;
  finishCombatAiV166Overlay(world, 0.1);

  assert.equal(heavy.phase, "breach-escaping-v166");
  assert.equal(heavy.repairSystem, "turret");
  assert.equal(world.events.some(event => event.type === "heavy-system-recovery-v166"), true);
});
