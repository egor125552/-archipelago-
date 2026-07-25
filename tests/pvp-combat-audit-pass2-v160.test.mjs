import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {applyCombatDamage, ensureCombat, updateCombat} from "../public/src/free-roam-combat-v2.js";

function pvpWorld() {
  const world = createFreeWorld();
  ensureCombat(world);
  world.freeActivities.presence = [true, true];
  world.freeActivities.inputs = [{}, {}];
  world.freeActivities.previousInputs = [{}, {}];
  world.freeActivities.marauder.active = false;
  world.freePursuerSquad.activated = false;
  world.freePursuerSquad.escorts = [];
  world.freeEnemyBoats = {active: false, level: 0, boats: [], projectiles: [], nextProjectileId: 1};
  world.freeHostileActors = {active: false, level: 0, actors: [], projectiles: [], nextProjectileId: 1};
  world.freeHostileGunners = {gunners: [], projectiles: [], eliminatedPursuers: [], nextProjectileId: 1};
  world.freeHeavyPursuer = {active: false, boat: null, projectiles: [], nextProjectileId: 1};
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 200, y: 58, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 218, y: 58, heading: -90});
  for (const player of world.players) {
    Object.assign(player.combat, {
      health: 100,
      alive: true,
      knockedDown: false,
      attackCooldown: 0,
      weapons: {...player.combat.weapons, automatic: true},
      equipped: "automatic",
      ammo: 50,
      lockedTargetId: null,
      lastTargetRequestId: null,
    });
  }
  world.events = [];
  return world;
}

test("simultaneous lethal automatic shots always favour player one", () => {
  const world = pvpWorld();
  world.players[0].combat.health = 11;
  world.players[1].combat.health = 11;
  world.freeActivities.inputs[0] = {attack: true, targetId: "player-1"};
  world.freeActivities.inputs[1] = {attack: true, targetId: "player-0"};
  world.freeActivities.previousInputs[0] = {attack: false, targetId: null};
  world.freeActivities.previousInputs[1] = {attack: false, targetId: null};

  updateCombat(world, 0.05, {});

  assert.equal(world.players[0].combat.alive, true);
  assert.equal(world.players[0].combat.health, 11);
  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.events.filter(event => event.type === "gun-shot").length, 1);
  assert.equal(world.events.find(event => event.type === "gun-shot")?.sourcePlayer, 0);
});

test("a killed player keeps their old combat lock through death and respawn", () => {
  const world = pvpWorld();
  world.players[1].combat.lockedTargetId = "player-0";
  world.players[1].combat.lastTargetRequestId = "player-0";

  applyCombatDamage(world, 1, 100, 0, {weapon: "automatic", eventType: "gun-hit"}, {});
  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.players[1].combat.lockedTargetId, "player-0");

  updateCombat(world, 8.1, {});

  assert.equal(world.players[1].combat.alive, true);
  assert.equal(world.players[1].combat.lockedTargetId, "player-0");
  assert.equal(world.players[1].combat.lastTargetRequestId, "player-0");
});

test("holding attack while dead fires at the stale target immediately after respawn", () => {
  const world = pvpWorld();
  world.players[1].combat.lockedTargetId = "player-0";
  world.players[1].combat.lastTargetRequestId = "player-0";
  applyCombatDamage(world, 1, 100, 0, {weapon: "automatic", eventType: "gun-hit"}, {});

  world.freeActivities.inputs[1] = {attack: true, targetId: "player-0"};
  world.freeActivities.previousInputs[1] = {attack: true, targetId: "player-0"};
  updateCombat(world, 8.1, {});
  assert.equal(world.players[1].combat.alive, true);
  assert.equal(world.players[0].combat.health, 100);

  updateCombat(world, 0.05, {});

  assert.equal(world.players[0].combat.health, 89);
  assert.ok(world.events.some(event => event.type === "gun-shot" && event.sourcePlayer === 1));
});
