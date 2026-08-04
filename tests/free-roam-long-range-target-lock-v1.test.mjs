import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {
  COMBAT_TARGET_LOCK_RANGE,
  updateCombat,
} from "../public/src/free-roam-combat-v2.js";

function enemyBoat(id, x, y) {
  return {
    id,
    role: "interceptor",
    x,
    y,
    heading: 0,
    speed: 0,
    hull: 60,
    maxHull: 60,
    active: true,
    destroyed: false,
    hostile: true,
    targetPlayer: 0,
    contactCooldown: 0,
    fireCooldown: 2,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
  };
}

function combatWorld() {
  const world = createFreeWorld();
  const player = world.players[0];
  Object.assign(player, {x: 100, y: 180, heading: 90, mode: "foot", activeBoat: null});
  player.combat.alive = true;
  player.combat.knockedDown = false;
  player.combat.weapons.automatic = true;
  player.combat.ammo = 40;
  player.combat.equipped = "automatic";
  player.combat.lockedTargetId = null;
  player.combat.lastTargetRequestId = null;
  world.freeActivities.presence = [true, false];
  world.freeContracts.encounterActive = true;
  world.freeEnemyBoats = {
    active: true,
    level: 3,
    boats: [enemyBoat("far-enemy", 350, 180)],
    projectiles: [],
    nextProjectileId: 1,
  };
  world.freeActivities.inputs[0] = {targetId: "far-enemy", attack: false, weapon: false};
  world.freeActivities.previousInputs[0] = {targetId: null, attack: false, weapon: false};
  world.events = [];
  return world;
}

function nextFrame(world, patch = {}) {
  world.freeActivities.previousInputs[0] = {...world.freeActivities.inputs[0]};
  world.freeActivities.inputs[0] = {...world.freeActivities.inputs[0], ...patch};
  world.time += 0.1;
  updateCombat(world, 0.1);
}

test("manual target selection holds an enemy beyond automatic range but within 320 metres", () => {
  const world = combatWorld();
  assert.equal(COMBAT_TARGET_LOCK_RANGE, 320);

  updateCombat(world, 0.1);
  assert.equal(world.players[0].combat.lockedTargetId, "far-enemy");
  assert.equal(world.events.filter(event => event.type === "target-locked").length, 1);
  assert.equal(world.events.some(event => event.type === "target-lost"), false);

  world.events = [];
  nextFrame(world);
  assert.equal(world.players[0].combat.lockedTargetId, "far-enemy");
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
  assert.equal(world.events.some(event => event.type === "target-auto-locked"), false);
});

test("automatic fire keeps the far lock, spends no ammo and gives one range notice", () => {
  const world = combatWorld();
  updateCombat(world, 0.1);
  const ammoBefore = world.players[0].combat.ammo;
  world.events = [];

  nextFrame(world, {attack: true});
  assert.equal(world.players[0].combat.lockedTargetId, "far-enemy");
  assert.equal(world.players[0].combat.ammo, ammoBefore);
  assert.equal(world.events.filter(event => event.type === "target-out-of-weapon-range").length, 1);
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
  assert.equal(world.events.some(event => event.type === "target-auto-locked"), false);

  nextFrame(world, {attack: true});
  assert.equal(world.events.filter(event => event.type === "target-out-of-weapon-range").length, 1);
});

test("pistol keeps the same far target without spending a cartridge", () => {
  const world = combatWorld();
  updateCombat(world, 0.1);
  const combat = world.players[0].combat;
  combat.equipped = "pistol";
  const ammoBefore = combat.pistolAmmo;
  world.events = [];

  nextFrame(world, {attack: true});
  assert.equal(combat.lockedTargetId, "far-enemy");
  assert.equal(combat.pistolAmmo, ammoBefore);
  assert.equal(world.events.filter(event => event.type === "target-out-of-weapon-range").length, 1);
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
});

test("destroying the retained target selects one real replacement without loss chatter", () => {
  const world = combatWorld();
  world.freeEnemyBoats.boats.push(enemyBoat("near-enemy", 190, 180));
  updateCombat(world, 0.1);
  world.events = [];
  world.freeEnemyBoats.boats[0].active = false;
  world.freeEnemyBoats.boats[0].destroyed = true;

  nextFrame(world);
  assert.equal(world.players[0].combat.lockedTargetId, "near-enemy");
  assert.equal(world.events.filter(event => event.type === "target-auto-locked").length, 1);
  assert.equal(world.events.some(event => event.type === "target-lost"), false);
  assert.equal(world.events.some(event => event.type === "target-cleared"), false);
});

test("a target beyond the long-range contract is rejected", () => {
  const world = combatWorld();
  world.freeEnemyBoats.boats[0].x = 421;
  updateCombat(world, 0.1);
  assert.equal(world.players[0].combat.lockedTargetId, null);
  assert.equal(world.events.filter(event => event.type === "target-lost").length, 1);
});
