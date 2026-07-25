import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {ensureCombat, updateCombat} from "../public/src/free-roam-combat-v2.js";
import {listCombatTargets, resolveCombatTarget} from "../public/src/free-roam-targeting.js";

function quietWorld() {
  const world = createFreeWorld();
  ensureCombat(world);
  world.freeActivities.presence = [true, true];
  world.freeActivities.inputs = [{}, {}];
  world.freeActivities.previousInputs = [{}, {}];
  world.freeActivities.marauder.active = false;
  world.freePursuerSquad.activated = false;
  world.freePursuerSquad.escorts = [];
  world.freePursuerSquad.projectiles = [];
  world.freeEnemyBoats = {active: false, level: 0, boats: [], projectiles: [], nextProjectileId: 1};
  world.freeHostileActors = {active: false, level: 0, actors: [], projectiles: [], nextProjectileId: 1};
  world.freeHostileGunners = {gunners: [], projectiles: [], eliminatedPursuers: [], nextProjectileId: 1};
  world.freeHeavyPursuer = {active: false, boat: null, projectiles: [], nextProjectileId: 1};
  for (const player of world.players) {
    player.combat.health = 100;
    player.combat.alive = true;
    player.combat.knockedDown = false;
    player.combat.knockdownRemaining = 0;
    player.combat.attackCooldown = 0;
  }
  world.events = [];
  return world;
}

function putOnFoot(world, index, x, y, heading = 0) {
  Object.assign(world.players[index], {mode: "foot", activeBoat: null, x, y, heading});
}

function armAutomatic(world, index, ammo = 40) {
  const combat = world.players[index].combat;
  combat.weapons.automatic = true;
  combat.equipped = "automatic";
  combat.ammo = ammo;
  combat.attackCooldown = 0;
}

function automaticShot(world, attackerIndex = 0) {
  const combat = world.players[attackerIndex].combat;
  combat.attackCooldown = 0;
  world.freeActivities.inputs[attackerIndex] = {attack: true};
  world.freeActivities.previousInputs[attackerIndex] = {attack: false};
  updateCombat(world, 0.05, {});
  world.time += 0.05;
}

test("a manually selected player target exposes the index used by automatic fire", () => {
  const world = quietWorld();
  putOnFoot(world, 0, 180, 60, 90);
  putOnFoot(world, 1, 200, 60, -90);
  const target = resolveCombatTarget(world, 0, "player-1", 420);
  assert.ok(target);
  assert.equal(target.kind, "player");
  assert.equal(target.playerIndex, 1);
  assert.equal(target.index, 1);
});

test("a locked automatic can damage and kill the other player", () => {
  const world = quietWorld();
  putOnFoot(world, 0, 180, 60, 90);
  putOnFoot(world, 1, 200, 60, -90);
  armAutomatic(world, 0, 20);
  world.players[1].combat.health = 22;
  world.players[0].combat.lockedTargetId = "player-1";

  automaticShot(world);
  assert.equal(world.players[1].combat.health, 11);
  assert.equal(world.players[1].combat.alive, true);

  automaticShot(world);
  assert.equal(world.players[1].combat.health, 0);
  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.players[1].mode, "dead");
  assert.ok(world.events.some(event => event.type === "player-death" && event.targetPlayer === 1));
  assert.ok(world.events.some(event => event.type === "player-defeated" && event.targetPlayer === 1));
});

test("the same locked automatic path works against a swimming player", () => {
  const world = quietWorld();
  putOnFoot(world, 0, 180, 100, 90);
  Object.assign(world.players[1], {mode: "swim", activeBoat: null, x: 200, y: 100, heading: -90});
  armAutomatic(world, 0, 10);
  world.players[0].combat.lockedTargetId = "player-1";
  automaticShot(world);
  assert.equal(world.players[1].combat.health, 89);
});

test("unlocked automatic fire bypasses the boat and damages a seated driver", () => {
  const world = quietWorld();
  const boat = world.boats[world.players[1].activeBoat];
  assert.ok(boat);
  Object.assign(boat, {x: 200, y: 120, hull: 100, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  putOnFoot(world, 0, 180, 120, 90);
  armAutomatic(world, 0, 10);
  world.players[0].combat.lockedTargetId = null;
  const beforeHealth = world.players[1].combat.health;
  const beforeHull = boat.hull;

  automaticShot(world);

  assert.ok(world.players[1].combat.health < beforeHealth);
  assert.equal(boat.hull, beforeHull);
});

test("the target menu hides a seated player even though unlocked automatic fire can hit them", () => {
  const world = quietWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {x: 200, y: 120, hull: 100, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  putOnFoot(world, 0, 180, 120, 90);
  const targets = listCombatTargets(world, 0, 420);
  assert.equal(targets.some(target => target.kind === "player" && target.playerIndex === 1), false);
  assert.equal(targets.some(target => target.kind === "boat" && target.playerIndex === 1), true);
});

test("melee attacks also pass through a boat and hit its seated driver", () => {
  const world = quietWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {x: 190, y: 120, hull: 100, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  putOnFoot(world, 0, 180, 120, 90);
  world.players[0].combat.equipped = "fists";
  const beforeHealth = world.players[1].combat.health;

  world.freeActivities.inputs[0] = {attack: true};
  world.freeActivities.previousInputs[0] = {attack: false};
  updateCombat(world, 0.12, {});
  world.freeActivities.inputs[0] = {attack: false};
  world.freeActivities.previousInputs[0] = {attack: true};
  updateCombat(world, 0.05, {});

  assert.ok(world.players[1].combat.health < beforeHealth);
  assert.equal(boat.hull, 100);
});

test("locked automatic fire at an occupied boat cannot defeat the seated player", () => {
  const world = quietWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {x: 200, y: 120, hull: 20, leak: 0, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  putOnFoot(world, 0, 180, 120, 90);
  armAutomatic(world, 0, 50);
  world.players[0].combat.lockedTargetId = `boat-${boat.id}`;

  for (let shot = 0; shot < 12; shot += 1) automaticShot(world);

  assert.equal(boat.hull, 0.05);
  assert.equal(boat.sunk, false);
  assert.equal(world.players[1].combat.health, 100);
  assert.equal(world.players[1].combat.alive, true);
});
