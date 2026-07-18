import test from "node:test";
import assert from "node:assert/strict";

import {
  WORLD,
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v5.js";

function stepMany(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function putOnShore(world, playerIndex = 0, x = 180, y = 50) {
  const player = world.players[playerIndex];
  const boat = world.boats[player.activeBoat ?? playerIndex];
  if (boat?.driver === playerIndex) boat.driver = null;
  player.mode = "foot";
  player.activeBoat = null;
  player.x = x;
  player.y = y;
  player.heading = 0;
}

test("Shift running is faster than walking and the shore has finite side bounds", () => {
  const world = createFreeWorld();
  putOnShore(world);

  setPlayerInput(world, 0, {right: true});
  stepMany(world, 0.8);
  const walkingDistance = world.players[0].x - 180;

  world.players[0].x = 180;
  world.players[0].stepTimer = 0;
  setPlayerInput(world, 0, {right: true, run: true});
  stepMany(world, 0.8);
  const runningDistance = world.players[0].x - 180;

  assert.ok(walkingDistance >= 4 && walkingDistance <= 8, String(walkingDistance));
  assert.ok(runningDistance > walkingDistance * 1.5, `${runningDistance}/${walkingDistance}`);
  assert.ok(runningDistance <= 13, String(runningDistance));
  assert.equal(world.players[0].running, true);

  world.players[0].x = WORLD.landMaxX - 0.2;
  drainEvents(world);
  stepMany(world, 0.8);
  assert.ok(world.players[0].x <= WORLD.landMaxX);
  assert.ok(drainEvents(world).some(event => event.type === "boundary"));
});

test("the finite shore still allows the player to enter the water", () => {
  const world = createFreeWorld();
  putOnShore(world, 0, 200, WORLD.shoreY + 1);
  setPlayerInput(world, 0, {down: true});
  stepMany(world, 0.35);
  assert.equal(world.players[0].mode, "swim");
  assert.ok(drainEvents(world).some(event => event.type === "splash"));
});

test("jump has an airborne arc and a distinct landing event", () => {
  const world = createFreeWorld();
  putOnShore(world);
  setPlayerInput(world, 0, {jump: true});
  stepFreeWorld(world, 0.05);
  assert.equal(world.players[0].airborne, true);
  assert.ok(world.players[0].jumpHeight > 0);

  setPlayerInput(world, 0, {jump: false});
  drainEvents(world);
  stepMany(world, 1.1);
  assert.equal(world.players[0].airborne, false);
  assert.equal(world.players[0].jumpHeight, 0);
  assert.ok(drainEvents(world).some(event => event.type === "landing"));
});

test("tow follows a turning tower without snapping and produces spatial strain cues", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {action: false, up: true, right: true});
  drainEvents(world);

  stepMany(world, 3.2);
  const tower = world.boats[world.tow?.towerBoat ?? 0];
  const towed = world.boats[world.tow?.towedBoat ?? 1];
  const metres = Math.hypot(tower.x - towed.x, tower.y - towed.y);

  assert.ok(world.tow, "tow should survive an ordinary powered turn");
  assert.ok(metres < WORLD.towMaximumLength, metres);
  assert.ok(Math.abs(towed.heading) > 3, towed.heading);
  assert.ok(world.tow.tension >= 0 && world.tow.tension <= 1.45);
  assert.ok(drainEvents(world).some(event => ["tow-creak", "tow-strain"].includes(event.type)));
});

test("a towed player can break the rope only by sustained opposing thrust", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {action: false, up: true});
  world.boats[1].heading = 180;
  setPlayerInput(world, 1, {up: true});
  drainEvents(world);

  stepMany(world, 4.2);
  assert.equal(world.tow, null);
  assert.ok(drainEvents(world).some(event => event.type === "tow-detach"));
});

test("boats hit an audible finite outer boundary", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.x = WORLD.width - WORLD.boatRadius - 0.01;
  boat.y = 190;
  boat.heading = 90;
  boat.speed = 12;
  boat.throttle = 1;
  drainEvents(world);

  stepMany(world, 0.25);
  assert.ok(boat.x < WORLD.width - WORLD.boatRadius, boat.x);
  assert.ok(Math.abs(boat.speed) < 4, boat.speed);
  assert.equal(boat.throttle, 0);
  assert.ok(drainEvents(world).some(event => event.type === "water-boundary"));
});

test("the v5 rope is solved once and survives turns in both directions", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {action: false, up: true, right: true});
  stepMany(world, 2.4);
  assert.ok(world.tow);
  const rightHeading = world.boats[1].heading;

  setPlayerInput(world, 0, {up: true, left: true});
  stepMany(world, 3.4);
  assert.ok(world.tow, "ordinary S-turn must not snap the rope");
  const metres = Math.hypot(world.boats[0].x - world.boats[1].x, world.boats[0].y - world.boats[1].y);
  assert.ok(metres <= WORLD.towMaximumLength, metres);
  assert.notEqual(world.boats[1].heading, rightHeading);
  assert.ok(world.tow.tension <= 1.45);
});
