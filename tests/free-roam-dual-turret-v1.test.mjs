import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {
  applyDualTurretBoatDamage,
  prepareDualTurretBoatRoom,
} from "../public/src/free-roam-dual-turret-boat.js";
import {
  assignPlayerToBoat,
  ensurePlayerBoat,
} from "../public/src/free-roam-player-boats.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication-v2.js";
import {
  DUAL_TURRET_SHOT_DAMAGE,
  DUAL_TURRET_SHOT_INTERVAL,
} from "../public/src/free-roam-dual-turret-config.js";

function pulse(world, playerIndex, input) {
  setPlayerInput(world, playerIndex, input);
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {});
  stepFreeWorld(world, 0.05);
}

function placeNearBoat(world, playerIndex, boat) {
  setPlayerPresence(world, playerIndex, true);
  const player = world.players[playerIndex];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = boat.x + (playerIndex ? 5 : -5);
  player.y = boat.y - 6;
  player.combat.alive = true;
}

function board(world, playerIndex, boat) {
  placeNearBoat(world, playerIndex, boat);
  pulse(world, playerIndex, {action: true});
  assert.equal(world.players[playerIndex].mode, "boat");
  assert.equal(world.players[playerIndex].activeBoat, boat.id);
}

function isolateBoat(world, selected) {
  for (const boat of world.boats) {
    if (!boat || boat.id === selected.id) continue;
    boat.sunk = true;
    boat.reserved = true;
    boat.x = 20 + boat.id * 20;
    boat.y = 290;
  }
}

test("the armored patrol is a normal player boat with two seats and shared metadata", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  assert.equal(boat.boatType, "dual-turret-patrol");
  assert.equal(boat.crewCapacity, 2);
  assert.equal(boat.cargoCapacity, 5);
  assert.equal(boat.audioProfile, "standard");
  assert.equal(boat.structuralHull, 300);
  assert.equal(boat.armor, 200);
  assert.equal(boat.turrets.length, 2);

  board(world, 0, boat);
  board(world, 1, boat);
  assert.deepEqual(boat.crew, [0, 1]);
  assert.equal(boat.driver, 0);
  assert.equal(boat.turrets[0].assignedPlayer, 0);
  assert.equal(boat.turrets[1].assignedPlayer, 1);
});

test("the armored patrol uses the same movement step as a light boat", () => {
  const ordinaryWorld = createFreeWorld();
  const ordinary = ensurePlayerBoat(ordinaryWorld.boats[0]);
  isolateBoat(ordinaryWorld, ordinary);
  setPlayerPresence(ordinaryWorld, 0, true);
  ordinaryWorld.players[0].mode = "boat";
  ordinaryWorld.players[0].activeBoat = ordinary.id;
  ordinary.driver = 0;
  ordinary.crew = [0];
  Object.assign(ordinary, {x: 200, y: 220, heading: 0, speed: 0, throttle: 0, rudder: 0, engineStalled: false});

  const armoredWorld = createFreeWorld();
  const armored = prepareDualTurretBoatRoom(armoredWorld);
  isolateBoat(armoredWorld, armored);
  setPlayerPresence(armoredWorld, 0, true);
  assignPlayerToBoat(armoredWorld, 0, armored);
  Object.assign(armored, {x: 200, y: 220, heading: 0, speed: 0, throttle: 0, rudder: 0, engineStalled: false});

  setPlayerInput(ordinaryWorld, 0, {up: true, right: true});
  setPlayerInput(armoredWorld, 0, {up: true, right: true});
  for (let index = 0; index < 12; index += 1) {
    stepFreeWorld(ordinaryWorld, 0.05);
    stepFreeWorld(armoredWorld, 0.05);
  }

  assert.ok(Math.abs(ordinary.speed - armored.speed) < 0.001, `${ordinary.speed} versus ${armored.speed}`);
  assert.ok(Math.abs(ordinary.heading - armored.heading) < 0.001, `${ordinary.heading} versus ${armored.heading}`);
  assert.ok(Math.abs(ordinary.x - armored.x) < 0.001, `${ordinary.x} versus ${armored.x}`);
  assert.ok(Math.abs(ordinary.y - armored.y) < 0.001, `${ordinary.y} versus ${armored.y}`);
});

test("action exits the armored patrol into open water after a full stop", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  boat.x = 210;
  boat.y = 210;
  boat.speed = 0;
  for (const crate of world.freeActivities.crates) {
    crate.x = 20;
    crate.y = 20;
  }

  pulse(world, 0, {action: true});
  assert.equal(world.players[0].mode, "swim");
  assert.equal(world.players[0].activeBoat, null);
  assert.equal(boat.driver, null);
  assert.deepEqual(boat.crew, [null, null]);
});

test("a nearby crate is stowed instead of forcing the crew member out", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  boat.x = 210;
  boat.y = 190;
  world.players[0].x = boat.x;
  world.players[0].y = boat.y;
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "fuel");
  crate.state = "world";
  crate.x = boat.x + 2;
  crate.y = boat.y;

  pulse(world, 0, {action: true});
  assert.equal(world.players[0].mode, "boat");
  assert.equal(crate.state, "stowed");
  assert.equal(crate.stowedBoat, boat.id);
  assert.ok(boat.cargo.includes(crate.id));
});

test("a full configurable hold is announced and never ejects the player", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  boat.x = 210;
  boat.y = 190;
  boat.cargoCapacity = 1;
  world.players[0].x = boat.x;
  world.players[0].y = boat.y;
  const [first, second] = world.freeActivities.crates;
  for (const crate of world.freeActivities.crates) {
    crate.x = 20;
    crate.y = 20;
  }
  first.state = "world";
  first.x = boat.x + 1;
  first.y = boat.y;
  pulse(world, 0, {action: true});
  assert.equal(first.state, "stowed");

  second.state = "world";
  second.x = boat.x + 1;
  second.y = boat.y;
  pulse(world, 0, {action: true});
  assert.equal(second.state, "world");
  assert.equal(world.players[0].mode, "boat");
  assert.ok(world.events.some(event => event.type === "cargo-full"));
});

test("the second seat cannot steer but can run the common pump", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  board(world, 1, boat);
  const heading = boat.heading;
  boat.water = 60;
  boat.leak = 0;
  const beforeWater = boat.water;

  setPlayerInput(world, 1, {right: true, up: true, pump: true});
  for (let index = 0; index < 10; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.driver, 0);
  assert.equal(boat.heading, heading);
  assert.equal(boat.speed, 0);
  assert.equal(boat.pumpActive, true);
  assert.ok(boat.water < beforeWater - 5);
});

test("common repair restores extended structure, armor and leak", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  boat.armor = 120;
  boat.structuralHull = 240;
  boat.hull = 80;
  boat.leak = 5;
  const patches = boat.repairPatches;

  setPlayerInput(world, 0, {repair: true});
  for (let index = 0; index < 34; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.repairPatches, patches - 1);
  assert.ok(boat.armor > 120);
  assert.ok(boat.structuralHull > 240);
  assert.ok(boat.leak < 5);
});

test("a healthy empty patrol boat does not repeatedly restart its engine", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.engineStalled = false;
  boat.fuel = 100;
  boat.water = 0;
  world.events.length = 0;
  for (let index = 0; index < 120; index += 1) stepFreeWorld(world, 0.05);
  const restarts = world.events.filter(event => event.type === "engine-water-restart");
  assert.equal(restarts.length, 0);
  assert.equal(boat.engineStalled, false);
});

test("the mounted installation applies damage immediately without a replicated projectile", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  const combat = world.players[0].combat;
  combat.equipped = "dual-turret";
  const target = world.freeActivities.marauder;
  assert.ok(target, "marauder target must exist in the free-roam world");
  target.active = true;
  target.destroyed = false;
  target.hull = 100;
  target.x = boat.x;
  target.y = boat.y - 40;
  combat.lockedTargetId = target.id;
  const ammo = boat.turrets[0].ammo;

  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  assert.equal(target.hull, 100 - DUAL_TURRET_SHOT_DAMAGE);
  assert.equal(boat.turrets[0].ammo, ammo - 1);
  assert.equal(world.freeDualTurretProjectiles.projectiles.length, 0);
  assert.ok(world.events.some(event => event.type === "dual-turret-hit" && event.instant));
});

test("the installation is fast but remains rate-limited by the server", () => {
  assert.equal(DUAL_TURRET_SHOT_INTERVAL, 0.18);
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  world.players[0].combat.equipped = "dual-turret";
  const target = world.freeActivities.marauder;
  assert.ok(target);
  target.active = true;
  target.destroyed = false;
  target.hull = 1000;
  target.x = boat.x;
  target.y = boat.y - 40;
  world.players[0].combat.lockedTargetId = target.id;
  const ammo = boat.turrets[0].ammo;

  setPlayerInput(world, 0, {attack: true});
  for (let index = 0; index < 20; index += 1) stepFreeWorld(world, 0.05);
  const spent = ammo - boat.turrets[0].ammo;
  assert.ok(spent >= 4 && spent <= 6, `spent ${spent}`);
  assert.equal(world.freeDualTurretProjectiles.projectiles.length, 0);
});

test("the installation refuses its own crew without spending ammunition", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  board(world, 1, boat);
  world.players[0].combat.equipped = "dual-turret";
  world.players[0].combat.lockedTargetId = "player-1";
  const ammo = boat.turrets[0].ammo;

  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  assert.equal(boat.turrets[0].ammo, ammo);
  assert.equal(world.freeDualTurretProjectiles.projectiles.length, 0);
});

test("the living passenger becomes driver when the first driver dies", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  isolateBoat(world, boat);
  board(world, 0, boat);
  board(world, 1, boat);
  world.players[0].combat.alive = false;
  world.players[0].combat.respawnRemaining = 8;
  world.players[0].mode = "dead";
  world.players[0].activeBoat = null;

  stepFreeWorld(world, 0.05);
  assert.deepEqual(boat.crew, [null, 1]);
  assert.equal(boat.driver, 1);
  assert.equal(world.players[1].activeBoat, boat.id);
});

test("damage uses the common player-boat damage entry point", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  const armor = boat.armor;
  const structure = boat.structuralHull;
  const impact = applyDualTurretBoatDamage(world, boat, 20, {emit: false});
  assert.ok(impact.absorbed > 0);
  assert.equal(boat.armor, armor - impact.absorbed);
  assert.equal(boat.structuralHull, structure - impact.damage);
});

test("replication contains generic boat metadata but no moving mounted shots", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.crew = [0, 1];
  boat.turrets[0].assignedPlayer = 0;
  const snapshot = replicatedFreeWorld(world);
  const replicated = snapshot.boats.find(candidate => candidate.boatType === "dual-turret-patrol");
  assert.equal(replicated.crewCapacity, 2);
  assert.equal(replicated.audioProfile, "standard");
  assert.equal(replicated.structuralHull, 300);
  assert.deepEqual(replicated.crew, [0, 1]);
  assert.equal(replicated.turrets.length, 2);
  assert.deepEqual(snapshot.freeDualTurretProjectiles, {mode: "instant"});
});

test("the release contains one engine path, instant shots and fresh client entry points", async () => {
  const {readFile} = await import("node:fs/promises");
  const [core, client, audio, projectiles, replication, activities, html, wrangler] = await Promise.all([
    readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-projectiles.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-replication-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-activities.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(core, /preparePlayerBoatStep/);
  assert.doesNotMatch(core, /applyMotionProfile/);
  assert.doesNotMatch(client, /ensureLoopWithoutStandardDualEngine/);
  assert.doesNotMatch(audio, /dual-turret-engine/);
  assert.match(projectiles, /mode: "instant"/);
  assert.doesNotMatch(replication, /previousX/);
  assert.match(activities, /boat\.cargoCapacity/);
  assert.match(html, /free-roam-dual-turret-client\.js\?v=4/);
  assert.match(html, /free-roam-v4\.js\?v=61/);
  assert.match(wrangler, /src\/worker-resilient\.js/);
});
