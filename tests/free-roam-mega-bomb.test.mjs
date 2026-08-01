import assert from "node:assert/strict";
import test from "node:test";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {
  MEGA_BOMB_RADIUS,
  MEGA_BOMB_START_AMMO,
  megaBombStatus,
} from "../src/free-roam-mega-bomb.js";

function installTargets(world) {
  world.freeEnemyBoats = {
    active: true,
    level: 4,
    nextProjectileId: 1,
    projectiles: [],
    boats: [
      {
        id: "bomb-target-a",
        role: "gunboat",
        x: 210,
        y: 195,
        heading: 180,
        speed: 0,
        hull: 76,
        maxHull: 76,
        active: true,
        destroyed: false,
        hostile: true,
        targetPlayer: 0,
        crewSeats: 0,
      },
      {
        id: "bomb-target-b",
        role: "interceptor",
        x: 219,
        y: 199,
        heading: 180,
        speed: 0,
        hull: 76,
        maxHull: 76,
        active: true,
        destroyed: false,
        hostile: true,
        targetPlayer: 0,
        crewSeats: 0,
      },
    ],
  };
  world.freeHeavyPursuer = {
    active: true,
    encounterId: 99,
    projectiles: [],
    nextProjectileId: 1,
    boat: {
      id: "heavy-pursuer",
      role: "heavy",
      x: 214,
      y: 197,
      heading: 180,
      turretHeading: 180,
      speed: 0,
      hull: 700,
      maxHull: 700,
      engineHealth: 180,
      maxEngineHealth: 180,
      turretHealth: 240,
      maxTurretHealth: 240,
      engineDisabled: false,
      turretDisabled: false,
      active: true,
      destroyed: false,
      targetPlayer: 0,
      burstRemaining: 0,
      aimRemaining: 0,
      fireCooldown: 99,
      contactCooldown: 99,
      ramCooldown: 99,
      crewSeats: 0,
    },
  };
}

function pulseBomb(server) {
  assert.equal(applyServerFreeInput(server, "captain", {megaBomb: true}, 0), true);
  assert.equal(applyServerFreeInput(server, "captain", {megaBomb: false}, 0), true);
}

test("server mega-bomb flies, destroys a group and heavily damages the heavy turret", () => {
  const server = createServerFreeRoom(1_000);
  setServerFreePresence(server, "captain", true);
  const player = server.world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 210;
  player.y = 250;
  player.heading = 0;
  player.combat.lockedTargetId = "bomb-target-a";
  player.combat.health = 100;
  installTargets(server.world);

  assert.equal(megaBombStatus(server.world).ammo[0], MEGA_BOMB_START_AMMO);
  pulseBomb(server);

  const events = [];
  for (let step = 1; step <= 90; step += 1) {
    const snapshot = tickServerFreeRoom(server, 1_000 + step * 40);
    events.push(...(snapshot.events || []));
    if (events.some(event => event.type === "mega-bomb-explosion")) break;
  }

  const explosion = events.find(event => event.type === "mega-bomb-explosion");
  assert.ok(explosion, "the authoritative projectile must physically reach an explosion");
  assert.ok(events.some(event => event.type === "mega-bomb-flight"), "the flight must emit spatial positions before impact");
  assert.equal(server.world.freeEnemyBoats.boats[0].destroyed, true);
  assert.equal(server.world.freeEnemyBoats.boats[1].destroyed, true);
  assert.ok(server.world.freeHeavyPursuer.boat.turretHealth < 90, "a near heavy turret must lose most of its durability");
  assert.ok(server.world.freeHeavyPursuer.boat.hull < 700, "the heavy hull must also take blast damage");
  assert.equal(player.combat.health, 100, "the first version intentionally has no friendly blast damage");
  assert.equal(player.combat.megaBombAmmo, MEGA_BOMB_START_AMMO - 1);
  assert.ok(explosion.radius === MEGA_BOMB_RADIUS);
  assert.ok(explosion.destroyedCount >= 2);
});

test("a player cannot stack a second mega-bomb while the first one is flying", () => {
  const server = createServerFreeRoom(2_000);
  setServerFreePresence(server, "captain", true);
  const player = server.world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 210;
  player.y = 250;
  player.heading = 0;
  installTargets(server.world);

  pulseBomb(server);
  tickServerFreeRoom(server, 2_040);
  assert.equal(player.combat.megaBombAmmo, MEGA_BOMB_START_AMMO - 1);
  pulseBomb(server);
  const snapshot = tickServerFreeRoom(server, 2_080);
  assert.equal(player.combat.megaBombAmmo, MEGA_BOMB_START_AMMO - 1);
  assert.ok(snapshot.events.some(event => event.type === "mega-bomb-denied"));
});
