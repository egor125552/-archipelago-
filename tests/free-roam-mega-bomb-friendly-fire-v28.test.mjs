import assert from "node:assert/strict";
import test from "node:test";

import {
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {
  MEGA_BOMB_START_AMMO,
  ensureMegaBombState,
  launchMegaBomb,
} from "../src/free-roam-mega-bomb.js";

function physicalProjectile(overrides = {}) {
  return {
    id: "mega-bomb-test",
    owner: 0,
    physicsVersion: 1,
    x: 80,
    y: 240,
    z: 0.05,
    vx: 0,
    vy: 0,
    vz: -3,
    heading: 0,
    age: 0.4,
    maxAge: 5,
    intendedDistance: 30,
    intendedFlightTime: 1,
    distanceTravelled: 0,
    energy: 1,
    bounces: 0,
    armed: true,
    nextFlightAt: 0,
    launchSpeed: 0,
    ...overrides,
  };
}

test("close blast can kill the owner and the second player", () => {
  const server = createServerFreeRoom(10_000);
  setServerFreePresence(server, "captain", true);
  setServerFreePresence(server, "crew", true);
  Object.assign(server.world.players[0], {mode: "foot", activeBoat: null, x: 80, y: 240});
  Object.assign(server.world.players[1], {mode: "foot", activeBoat: null, x: 82, y: 240});
  ensureMegaBombState(server.world).projectiles = [physicalProjectile()];

  const snapshot = tickServerFreeRoom(server, 10_040);
  const explosion = snapshot.events.find(event => event.type === "mega-bomb-explosion");

  assert.ok(explosion);
  assert.equal(server.world.players[0].combat.alive, false);
  assert.equal(server.world.players[1].combat.alive, false);
  assert.ok(explosion.playerDeathCount >= 2);
});

test("blast damages the launcher's own boat", () => {
  const server = createServerFreeRoom(20_000);
  setServerFreePresence(server, "captain", true);
  const boat = server.world.boats[0];
  Object.assign(boat, {x: 80, y: 240, heading: 0, speed: 0, hull: 100, water: 0, leak: 0, sunk: false});
  Object.assign(server.world.players[0], {mode: "boat", activeBoat: boat.id});
  ensureMegaBombState(server.world).projectiles = [physicalProjectile()];

  const snapshot = tickServerFreeRoom(server, 20_040);

  assert.ok(boat.hull < 100);
  assert.ok(boat.water > 0 || boat.leak > 0);
  assert.ok(snapshot.events.some(event => event.type === "mega-bomb-boat-hit"));
});

test("a moving boat changes the authoritative launch velocity", () => {
  const server = createServerFreeRoom(30_000);
  setServerFreePresence(server, "captain", true);
  const boat = server.world.boats[0];
  Object.assign(boat, {x: 80, y: 240, heading: 0, speed: 18, sunk: false});
  Object.assign(server.world.players[0], {mode: "boat", activeBoat: boat.id, heading: 0});
  const combat = server.world.players[0].combat;
  combat.megaBombAmmo = MEGA_BOMB_START_AMMO;
  combat.megaBombCooldown = 0;

  assert.equal(launchMegaBomb(server.world, 0), true);
  const projectile = server.world.freeMegaBombs.projectiles[0];

  assert.ok(projectile.sourceSpeed > 17);
  assert.ok(Math.abs(projectile.vy) > 55);
});

test("low shore hit emits a ricochet and reverses the real trajectory", () => {
  const server = createServerFreeRoom(40_000);
  setServerFreePresence(server, "captain", true);
  ensureMegaBombState(server.world).projectiles = [physicalProjectile({
    x: 116.5,
    y: 40,
    z: 1.8,
    vx: 45,
    vy: 0,
    vz: -1,
  })];

  const snapshot = tickServerFreeRoom(server, 40_040);
  const ricochet = snapshot.events.find(event => event.type === "mega-bomb-ricochet");

  assert.ok(ricochet);
  assert.ok(ricochet.vx < 0);
  assert.ok(ricochet.bounces >= 1);
});
