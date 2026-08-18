import test from "node:test";
import assert from "node:assert/strict";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {ensureMegaBombState} from "../src/free-roam-mega-bomb.js";
import {createMegaBombProjectile} from "../src/free-roam-mega-bomb-physics-v1.js";

function enterSpatialLab(room, now, sequenceStart = 1) {
  const player = room.world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 270;
  player.y = 55;

  applyServerFreeInput(room, "captain", {action: true}, sequenceStart);
  applyServerFreeInput(room, "captain", {action: false}, sequenceStart + 1);
  const snapshot = tickServerFreeRoom(room, now + 40);

  assert.equal(player.spatialLocationId, "location.spatial.lab");
  assert.ok(player.spatialSpaceId);
  return snapshot;
}

function putHostileBombOnPlayer(room, id) {
  const player = room.world.players[0];
  const bomb = createMegaBombProjectile({
    id,
    owner: -1,
    start: {x: player.x, y: player.y, z: 2},
    heading: 0,
    intendedDistance: 18,
  });
  bomb.x = player.x;
  bomb.y = player.y;
  bomb.z = 0.3;
  bomb.vx = 0;
  bomb.vy = 0;
  bomb.vz = 0;
  bomb.age = bomb.maxAge + 0.1;
  bomb.armed = true;
  bomb.hostile = true;
  bomb.targetPlayer = 0;
  ensureMegaBombState(room.world).projectiles.push(bomb);
}

test("legacy mega-bomb launch is denied while player is inside a spatial location", () => {
  const room = createServerFreeRoom(1_000);
  setServerFreePresence(room, "captain", true);
  enterSpatialLab(room, 1_000);

  const player = room.world.players[0];
  const stockBefore = player.combat.megaBombStock;
  const projectilesBefore = ensureMegaBombState(room.world).projectiles.length;

  applyServerFreeInput(room, "captain", {megaBomb: true}, 3);
  applyServerFreeInput(room, "captain", {megaBomb: false}, 4);
  const snapshot = tickServerFreeRoom(room, 1_080);

  assert.equal(player.combat.megaBombStock, stockBefore);
  assert.equal(ensureMegaBombState(room.world).projectiles.length, projectilesBefore);
  assert.ok(snapshot.events.some(event => (
    event.type === "mega-bomb-denied"
    && event.reason === "spatial-boundary"
  )));
});

test("outside hostile blast cannot damage, stun or kill player inside spatial location", () => {
  const room = createServerFreeRoom(2_000);
  setServerFreePresence(room, "captain", true);
  enterSpatialLab(room, 2_000);

  const player = room.world.players[0];
  const healthBefore = player.combat.health;
  putHostileBombOnPlayer(room, "hostile-spatial-regression");

  const snapshot = tickServerFreeRoom(room, 2_080);

  assert.equal(player.combat.health, healthBefore);
  assert.equal(player.combat.alive, true);
  assert.equal(player.combat.knockedDown, false);
  assert.equal(room.world.freeActivities.presence[0], true, "temporary legacy isolation must restore presence");
  assert.ok(snapshot.events.some(event => (
    event.type === "mega-bomb-explosion"
    && event.projectileId === "hostile-spatial-regression"
  )));
  assert.equal(snapshot.events.some(event => (
    event.type === "mega-bomb-player-hit"
    && event.targetPlayer === 0
  )), false);
});

test("same hostile blast still damages a player who is outside spatial locations", () => {
  const room = createServerFreeRoom(3_000);
  setServerFreePresence(room, "captain", true);
  const player = room.world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.spatialLocationId = null;
  player.spatialSpaceId = null;
  player.x = 330;
  player.y = 120;
  const healthBefore = player.combat.health;
  putHostileBombOnPlayer(room, "hostile-outside-control");

  const snapshot = tickServerFreeRoom(room, 3_040);

  assert.ok(player.combat.health < healthBefore || player.combat.alive === false);
  assert.ok(snapshot.events.some(event => (
    event.type === "mega-bomb-player-hit"
    && event.targetPlayer === 0
  )));
});