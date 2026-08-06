import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {
  finishDualTurretBoatStep,
  prepareDualTurretBoatRoom,
  prepareDualTurretBoatStep,
} from "../public/src/free-roam-dual-turret-boat.js";
import {applyCollisionDamage} from "../public/src/collision-model.js";
import {stepDualTurretProjectiles} from "../public/src/free-roam-dual-turret-projectiles.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication-v2.js";

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
  player.y = boat.y - 8;
  player.combat.alive = true;
}

test("the dual-turret patrol boat is one physical shared object with two crew seats", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeActivities.credits = 500;
  assert.equal(boat.boatType, "dual-turret-patrol");
  assert.equal(boat.structuralHull, 300);
  assert.equal(boat.armor, 200);
  assert.equal(boat.turrets.length, 2);
  assert.equal(boat.turrets[0].ammo, 1000);
  assert.equal(boat.turrets[1].ammo, 1000);

  placeNearBoat(world, 0, boat);
  placeNearBoat(world, 1, boat);
  pulse(world, 0, {action: true});
  assert.equal(world.freeDualTurretPurchase.purchased, true);
  assert.equal(world.freeDualTurretPurchase.price, 0);
  assert.equal(world.freeActivities.credits, 500);
  pulse(world, 1, {action: true});

  assert.equal(world.players[0].activeBoat, boat.id);
  assert.equal(world.players[1].activeBoat, boat.id);
  assert.deepEqual(boat.crew, [0, 1]);
  assert.equal(boat.driver, 0);
  assert.equal(boat.turrets[0].assignedPlayer, 0);
  assert.equal(boat.turrets[1].assignedPlayer, 1);
});

test("existing weapon gesture cycles to a player's mounted installation without a new input", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  world.players[0].combat.weapons.automatic = true;
  world.players[0].combat.ammo = 20;
  world.players[0].combat.equipped = "pistol";
  pulse(world, 0, {weapon: true});
  assert.equal(world.players[0].combat.equipped, "automatic");
  pulse(world, 0, {weapon: true});
  assert.equal(world.players[0].combat.equipped, "dual-turret");
});

test("a mounted shot becomes a server projectile and inherits boat movement", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  world.players[0].combat.equipped = "dual-turret";
  boat.speed = 7;
  const target = world.freeActivities.marauder;
  target.active = true;
  target.destroyed = false;
  target.x = boat.x - 40;
  target.y = boat.y + 20;
  world.boats[0].sunk = true;
  world.boats[1].sunk = true;
  world.players[0].combat.lockedTargetId = target.id;
  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  const projectile = world.freeDualTurretProjectiles.projectiles[0];
  assert.ok(projectile);
  assert.ok(Math.hypot(projectile.inheritedBoatVelocity.x, projectile.inheritedBoatVelocity.y) > 0);
  assert.equal(projectile.sourceBoatId, boat.id);
});

test("replication includes real hull points, crew, turrets and physical projectiles", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.crew = [0, 1];
  boat.turrets[0].assignedPlayer = 0;
  world.freeDualTurretPurchase.purchased = true;
  const snapshot = replicatedFreeWorld(world);
  const replicatedBoat = snapshot.boats.find(candidate => candidate.boatType === "dual-turret-patrol");
  assert.equal(replicatedBoat.structuralHull, 300);
  assert.deepEqual(replicatedBoat.crew, [0, 1]);
  assert.equal(replicatedBoat.turrets.length, 2);
  assert.ok(snapshot.freeDualTurretProjectiles);
  assert.equal(snapshot.freeDualTurretPurchase.purchased, true);
});


test("the prototype patrol boat boards immediately without spending credits", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeActivities.credits = 17;
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  assert.equal(world.freeDualTurretPurchase.purchased, true);
  assert.equal(world.freeDualTurretPurchase.price, 0);
  assert.equal(world.players[0].activeBoat, boat.id);
  assert.equal(world.freeActivities.credits, 17);
});

test("a sunk prototype removes its crew and fully returns after sixty seconds", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  placeNearBoat(world, 0, boat);
  placeNearBoat(world, 1, boat);
  pulse(world, 0, {action: true});
  pulse(world, 1, {action: true});
  boat.sunk = true;
  stepFreeWorld(world, 0.05);
  assert.equal(boat.sunk, true);
  assert.deepEqual(boat.crew, [null, null]);
  assert.equal(world.players[0].activeBoat, null);
  assert.equal(world.players[1].activeBoat, null);
  for (let index = 0; index < 601; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, false);
  assert.equal(boat.structuralHull, 300);
  assert.equal(boat.armor, 200);
  assert.equal(boat.water, 0);
  assert.equal(boat.leak, 0);
  assert.equal(boat.turrets[0].ammo, 1000);
  assert.equal(boat.turrets[1].ammo, 1000);
});

test("the second crew position cannot steer the shared physical boat", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  placeNearBoat(world, 1, boat);
  pulse(world, 0, {action: true});
  pulse(world, 1, {action: true});
  const heading = boat.heading;
  setPlayerInput(world, 1, {right: true, up: true});
  stepFreeWorld(world, 0.1);
  assert.equal(boat.driver, 0);
  assert.equal(boat.heading, heading);
  assert.equal(boat.speed, 0);
});


test("pump input reaches the shared boat and lowers flooding", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  boat.water = 60;
  boat.leak = 2;
  const before = boat.water;
  setPlayerInput(world, 0, {pump: true});
  for (let index = 0; index < 10; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.pumpActive, true);
  assert.ok(boat.water < before - 5, `${boat.water} should be below ${before}`);
});

test("repair plates restore armor, structural hull and leak", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  boat.armor = 120;
  boat.structuralHull = 240;
  boat.hull = 80;
  boat.leak = 5;
  const patches = boat.repairPatches;
  setPlayerInput(world, 0, {repair: true});
  for (let index = 0; index < 32; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.repairPatches, patches - 1);
  assert.ok(boat.armor > 120);
  assert.ok(boat.structuralHull > 240);
  assert.ok(boat.leak < 5);
});

test("target confirmation preserves the mounted installation instead of forcing the automatic", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  pulse(world, 0, {action: true});
  const combat = world.players[0].combat;
  combat.weapons.automatic = true;
  combat.ammo = 20;
  combat.equipped = "dual-turret";
  const target = world.freeActivities.marauder;
  target.active = true;
  target.destroyed = false;
  target.x = boat.x - 25;
  target.y = boat.y - 35;
  setPlayerInput(world, 0, {targetId: target.id});
  stepFreeWorld(world, 0.05);
  assert.equal(combat.equipped, "dual-turret");
});

test("the installation refuses its own shared boat and crew without consuming ammunition", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  placeNearBoat(world, 1, boat);
  pulse(world, 0, {action: true});
  pulse(world, 1, {action: true});
  const turret = boat.turrets[0];
  const beforeAmmo = turret.ammo;
  world.players[0].combat.equipped = "dual-turret";
  world.players[0].combat.lockedTargetId = "player-1";
  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  assert.equal(turret.ammo, beforeAmmo);
  assert.equal(world.freeDualTurretProjectiles.projectiles.length, 0);
});

test("when the driver dies the living second crew member becomes the driver", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.freeDualTurretPurchase.purchased = true;
  placeNearBoat(world, 0, boat);
  placeNearBoat(world, 1, boat);
  pulse(world, 0, {action: true});
  pulse(world, 1, {action: true});
  world.players[0].combat.alive = false;
  world.players[0].combat.respawnRemaining = 8;
  world.players[0].mode = "dead";
  world.players[0].activeBoat = null;
  stepFreeWorld(world, 0.05);
  assert.deepEqual(boat.crew, [null, 1]);
  assert.equal(boat.driver, 1);
  assert.equal(world.players[1].activeBoat, boat.id);
});


test("legacy collision damage stays point-based against the 300-point structure", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  const beforeHull = boat.structuralHull;
  const beforeArmor = boat.armor;
  const context = prepareDualTurretBoatStep(world);
  const impact = applyCollisionDamage(boat, 10);
  finishDualTurretBoatStep(world, context, 0.01);
  assert.ok(impact.absorbed > 0);
  assert.ok(boat.armor < beforeArmor);
  assert.ok(Math.abs((beforeHull - boat.structuralHull) - impact.damage) < 0.001);
  assert.ok(boat.structuralHull > 290);
});

test("a fast physical projectile hits the first actor on its path", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  world.players[1].mode = "foot";
  world.players[1].activeBoat = null;
  world.players[1].x = 205.8;
  world.players[1].y = 80;
  world.players[1].combat.health = 100;
  const marauder = world.freeActivities.marauder;
  marauder.active = true;
  marauder.destroyed = false;
  marauder.x = 205.8;
  marauder.y = 69;
  const beforeMarauderHull = marauder.hull;
  world.freeDualTurretProjectiles.projectiles.push({
    id: "ordered-hit", turretId: "dual-turret-port", sourcePlayer: 0, sourceBoatId: boat.id,
    targetId: marauder.id, x: 205.8, y: 90, previousX: 205.8, previousY: 90,
    vx: 0, vy: -300, launchHeading: 0, inheritedBoatVelocity: {x: 0, y: 0},
    speed: 300, age: 0.3, ttl: 1, damage: 18, endReason: null,
  });
  stepDualTurretProjectiles(world, 0.1);
  assert.equal(world.players[1].combat.health, 82);
  assert.equal(marauder.hull, beforeMarauderHull);
  const ended = world.freeDualTurretProjectiles.endEvents.at(-1);
  assert.equal(ended.reason, "player-impact");
  assert.equal(ended.targetId, "player-1");
});

test("the release wiring stays modular and Safari receives a new cache version", async () => {
  const {readFile} = await import("node:fs/promises");
  const [server, entry, client, audio, replication, html] = await Promise.all([
    readFile(new URL("../src/free-roam-server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-developer-log-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-replication-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
  ]);
  assert.match(server, /free-roam-core-v8\.js/);
  assert.match(server, /free-roam-replication-v2\.js/);
  assert.doesNotMatch(entry, /dual-turret/);
  assert.match(client, /updateDualTurretProjectileAudio/);
  assert.match(audio, /dual-turret-engine-v1\.mp3\?v=1/);
  assert.match(audio, /dual-turret-shot-v1\.mp3\?v=1/);
  assert.match(replication, /freeDualTurretProjectiles/);
  assert.match(html, /free-roam-dual-turret-client\.js\?v=3/);
  assert.match(html, /free-roam-developer-log-v1\.js\?v=2/);
  assert.match(html, /бесплатно стоит тестовый двухместный бронекатер/);
  assert.match(client, /ensureLoopWithoutStandardDualEngine/);
});
