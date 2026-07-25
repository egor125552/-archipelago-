import test from "node:test";
import assert from "node:assert/strict";
import {normalizePersistedFreeWorld, storedList} from "../src/world-storage-normalization.js";
import {ensureEnemyBoats, activeEnemyBoats} from "../public/src/free-roam-enemy-boats.js";
import {contractCombatActive} from "../public/src/free-roam-combat-context.js";

const legacyList = (...items) => Object.fromEntries(items.map((item, index) => [String(index), item]));

test("storedList revives contiguous numeric-key objects", () => {
  assert.deepEqual(storedList(legacyList({id: "a"}, {id: "b"})), [{id: "a"}, {id: "b"}]);
  assert.deepEqual(storedList({named: true}), []);
});

test("persisted free worlds restore combat collections as arrays", () => {
  const world = normalizePersistedFreeWorld({
    players: legacyList({mode: "boat"}, {mode: "boat"}),
    boats: legacyList({id: 0}, {id: 1}),
    events: {},
    freeEnemyBoats: {active: true, boats: legacyList({id: "enemy-1", active: true, destroyed: false, hostile: true}), projectiles: {}},
    freeHostileActors: {actors: legacyList({id: "actor-1", active: true, destroyed: false}), projectiles: {}},
    freeHostileGunners: {gunners: {}, projectiles: {}},
    freePursuerSquad: {escorts: {}, projectiles: {}},
  });
  assert.equal(Array.isArray(world.players), true);
  assert.equal(Array.isArray(world.freeEnemyBoats.boats), true);
  assert.equal(Array.isArray(world.freeHostileActors.actors), true);
  assert.equal(Array.isArray(world.freeHostileGunners.gunners), true);
  assert.equal(Array.isArray(world.freePursuerSquad.escorts), true);
  assert.equal(activeEnemyBoats(world).length, 1);
  assert.equal(contractCombatActive(world), true);
});

test("enemy boat ensure repairs a malformed live snapshot", () => {
  const world = {freeEnemyBoats: {boats: legacyList({id: "enemy-1", active: true, destroyed: false}), projectiles: {}}};
  const state = ensureEnemyBoats(world);
  assert.equal(Array.isArray(state.boats), true);
  assert.equal(Array.isArray(state.projectiles), true);
  assert.equal(activeEnemyBoats(world).length, 1);
});
