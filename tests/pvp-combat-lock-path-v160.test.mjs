import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {ensureCombat, updateCombat} from "../public/src/free-roam-combat-v2.js";

function worldForPvp() {
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
  for (const player of world.players) {
    Object.assign(player.combat, {health: 100, alive: true, knockedDown: false, attackCooldown: 0});
  }
  world.events = [];
  return world;
}

function arm(world, targetId, ammo = 50) {
  const combat = world.players[0].combat;
  combat.weapons.automatic = true;
  combat.equipped = "automatic";
  combat.ammo = ammo;
  combat.attackCooldown = 0;
  combat.lockedTargetId = null;
  combat.lastTargetRequestId = null;
  world.freeActivities.inputs[0] = {attack: true, targetId};
  world.freeActivities.previousInputs[0] = {attack: false, targetId: null};
}

function shoot(world, targetId) {
  world.players[0].combat.attackCooldown = 0;
  world.freeActivities.inputs[0] = {attack: true, targetId};
  world.freeActivities.previousInputs[0] = {attack: false, targetId};
  updateCombat(world, 0.05, {});
  world.time += 0.05;
}

test("the real locked-target input path kills another player with an automatic", () => {
  const world = worldForPvp();
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 60, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 200, y: 60, heading: -90});
  world.players[1].combat.health = 22;
  arm(world, "player-1", 10);

  updateCombat(world, 0.05, {});
  assert.equal(world.players[0].combat.lockedTargetId, "player-1");
  assert.equal(world.players[1].combat.health, 11);
  shoot(world, "player-1");

  assert.equal(world.players[1].combat.health, 0);
  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.players[1].mode, "dead");
});

test("locking the occupied boat damages only the hull and cannot defeat its driver", () => {
  const world = worldForPvp();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {owner: 1, driver: 1, x: 200, y: 120, hull: 20, leak: 0, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 120, heading: 90});
  const targetId = `boat-${boat.id}`;
  arm(world, targetId, 50);

  updateCombat(world, 0.05, {});
  assert.equal(world.players[0].combat.lockedTargetId, targetId);
  for (let shot = 1; shot < 12; shot += 1) shoot(world, targetId);

  assert.equal(boat.hull, 0.05);
  assert.equal(boat.sunk, false);
  assert.equal(world.players[1].combat.health, 100);
  assert.equal(world.players[1].combat.alive, true);
});
