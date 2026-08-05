import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelGraceProtectedHostileBombsV37,
  hostileBombTargetPlayerV37,
  hostileExplosionTextV37,
} from "../src/free-roam-mega-bomb-v37.js";

test("hostile explosion text describes an enemy bomb instead of counting opponents", () => {
  assert.equal(hostileExplosionTextV37({hitCount: 0}), "Вражеская бомба промахнулась.");
  assert.equal(hostileExplosionTextV37({hitCount: 1, playerHitCount: 1}), "Вражеская бомба попала по игроку.");
  assert.equal(hostileExplosionTextV37({hitCount: 1, playerHitCount: 1, playerDeathCount: 1}), "Вражеская бомба попала. Игрок погиб.");
  assert.equal(hostileExplosionTextV37({reason: "respawn-grace"}), "Вражеская бомба взорвалась во время двухсекундной защиты и не нанесла урона.");
});

test("bomb request is associated with the nearest real player target", () => {
  const world = {
    players: [{x: 20, y: 20, mode: "foot"}, {x: 200, y: 200, mode: "foot"}],
    boats: [],
  };
  assert.equal(hostileBombTargetPlayerV37(world, {targetX: 205, targetY: 198}), 1);
});

test("an already flying hostile bomb cannot damage a player during respawn grace", () => {
  const world = {
    time: 10,
    events: [],
    freeThreatDirector: {graceUntil: [12]},
    freeMegaBombs: {projectiles: [{id: "hostile-1", owner: -1, targetPlayer: 0, x: 40, y: 50, z: 4}]},
  };
  assert.equal(cancelGraceProtectedHostileBombsV37(world), 1);
  assert.equal(world.freeMegaBombs.projectiles.length, 0);
  assert.equal(world.events[0].type, "mega-bomb-explosion");
  assert.equal(world.events[0].reason, "respawn-grace");
});
