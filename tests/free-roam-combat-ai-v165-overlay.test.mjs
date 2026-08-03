import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareCombatAiV165Overlay,
  finishCombatAiV165Overlay,
} from "../public/src/free-roam-combat-ai-model-v165.js";

function baseWorld() {
  return {
    time: 20,
    events: [],
    players: [
      {x: 100, y: 50, combat: {alive: true}},
      {x: 300, y: 50, combat: {alive: false}},
    ],
    freeHostileActors: {actors: []},
    freeHostileGunners: {gunners: []},
    freeHeavyPursuer: {boat: null},
    freeCombatAiV164: {heavy: null},
  };
}

test("overlay discards a legacy one-tick retarget movement", () => {
  const world = baseWorld();
  const actor = {
    id: "searcher",
    targetPlayer: 1,
    x: 220,
    y: 50,
    heading: 0,
    state: "foot",
    active: true,
    destroyed: false,
    returning: false,
    fireCooldown: 0,
    aimRemaining: 0,
    burstRemaining: 0,
    windupRemaining: 0,
  };
  world.freeHostileActors.actors.push(actor);
  prepareCombatAiV165Overlay(world);

  actor.x = 180;
  actor.targetPlayer = 0;
  finishCombatAiV165Overlay(world, 0.1);

  assert.equal(actor.targetPlayer, 1);
  assert.ok(actor.x >= 220);
  assert.equal(actor.burstRemaining, 0);
});

test("engine repair starts only after physical stopping", () => {
  const world = baseWorld();
  const boat = {
    id: "heavy-pursuer",
    active: true,
    destroyed: false,
    x: 260,
    y: 220,
    heading: 90,
    speed: 8,
    engineDisabled: true,
    turretDisabled: false,
    fireCooldown: 0,
    burstRemaining: 4,
    aimRemaining: 1,
  };
  world.freeHeavyPursuer.boat = boat;
  world.freeCombatAiV164.heavy = {
    phase: "combat",
    repairSystem: null,
    repairProgress: 0,
    repairQuarter: 0,
    repairPlates: 3,
    lastDamageAt: 20,
  };
  prepareCombatAiV165Overlay(world);

  world.freeCombatAiV164.heavy.phase = "repairing";
  world.freeCombatAiV164.heavy.repairSystem = "engine";
  world.freeCombatAiV164.heavy.repairProgress = 0.2;
  finishCombatAiV165Overlay(world, 0.1);
  assert.equal(world.freeCombatAiV164.heavy.phase, "stopping-v165");
  assert.equal(world.freeCombatAiV164.heavy.repairProgress, 0);
  assert.ok(boat.speed > 0);

  for (let i = 0; i < 30 && world.freeCombatAiV164.heavy.phase === "stopping-v165"; i += 1) {
    prepareCombatAiV165Overlay(world);
    finishCombatAiV165Overlay(world, 0.1);
    world.time += 0.1;
  }
  assert.equal(world.freeCombatAiV164.heavy.phase, "repairing");
  assert.equal(boat.speed, 0);
  assert.equal(world.events.some(event => event.type === "heavy-repair-start"), true);
});
