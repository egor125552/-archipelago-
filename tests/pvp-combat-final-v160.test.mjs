import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {ensureCombat, updateCombat} from "../public/src/free-roam-combat-v2.js";
import {listCombatTargets} from "../public/src/free-roam-targeting.js";

function createPvpWorld() {
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

function fire(world, targetId) {
  const attacker = world.players[0];
  attacker.combat.attackCooldown = 0;
  world.freeActivities.inputs[0] = {attack: true, targetId};
  world.freeActivities.previousInputs[0] = {attack: false, targetId: attacker.combat.lastTargetRequestId};
  updateCombat(world, 0.05, {});
  world.time += 0.05;
}

test("manual player targeting kills a player on foot with an automatic", () => {
  const world = createPvpWorld();
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 60, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 200, y: 60, heading: -90});
  world.players[1].combat.health = 22;

  fire(world, "player-1");
  assert.equal(world.players[1].combat.health, 11);
  fire(world, "player-1");

  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.players[1].mode, "dead");
  assert.ok(world.events.some(event => event.type === "player-death" && event.targetPlayer === 1));
});

test("a seated player and their boat are two separate selectable targets", () => {
  const world = createPvpWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {owner: 1, driver: 1, x: 200, y: 120, hull: 100, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 120, heading: 90});

  const targets = listCombatTargets(world, 0, 420);
  assert.ok(targets.some(target => target.id === "player-1" && target.kind === "player"));
  assert.ok(targets.some(target => target.id === `boat-${boat.id}` && target.kind === "boat"));
});

test("manual player targeting kills a seated driver and releases the controls", () => {
  const world = createPvpWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {owner: 1, driver: 1, x: 200, y: 120, hull: 100, throttle: 1, rudder: 0.5, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 120, heading: 90});
  world.players[1].combat.health = 22;

  fire(world, "player-1");
  fire(world, "player-1");

  assert.equal(world.players[1].combat.alive, false);
  assert.equal(world.players[1].mode, "dead");
  assert.equal(world.players[1].activeBoat, null);
  assert.equal(boat.driver, null);
  assert.equal(boat.throttle, 0);
  assert.equal(boat.rudder, 0);
});

test("selecting the boat damages hull without damaging its driver", () => {
  const world = createPvpWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {owner: 1, driver: 1, x: 200, y: 120, hull: 100, leak: 0, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 120, heading: 90});

  fire(world, `boat-${boat.id}`);

  assert.equal(boat.hull, 95);
  assert.equal(world.players[1].combat.health, 100);
  assert.equal(world.players[1].combat.alive, true);
});

test("melee still reaches a seated driver through the boat hull", () => {
  const world = createPvpWorld();
  const boat = world.boats[world.players[1].activeBoat];
  Object.assign(boat, {owner: 1, driver: 1, x: 190, y: 120, hull: 100, sunk: false});
  Object.assign(world.players[1], {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y});
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 120, heading: 90});
  world.players[0].combat.equipped = "fists";
  const before = world.players[1].combat.health;

  world.freeActivities.inputs[0] = {attack: true, targetId: null};
  world.freeActivities.previousInputs[0] = {attack: false, targetId: null};
  updateCombat(world, 0.12, {});
  world.freeActivities.inputs[0] = {attack: false, targetId: null};
  world.freeActivities.previousInputs[0] = {attack: true, targetId: null};
  updateCombat(world, 0.05, {});

  assert.ok(world.players[1].combat.health < before);
  assert.equal(boat.hull, 100);
});
