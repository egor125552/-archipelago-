import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {prepareDualTurretBoatRoom} from "../public/src/free-roam-dual-turret-boat.js";

function placeAboard(world, playerIndex, boat) {
  setPlayerPresence(world, playerIndex, true);
  const player = world.players[playerIndex];
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  player.combat.alive = true;
  player.combat.health = 100;
}

test("a living passenger becomes driver when the original driver dies", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.driver = 0;
  boat.crew = [0, 1];
  placeAboard(world, 0, boat);
  placeAboard(world, 1, boat);
  stepFreeWorld(world, 0.01);

  world.players[0].combat.alive = false;
  world.players[0].combat.health = 0;
  world.players[0].mode = "dead";
  world.players[0].activeBoat = null;
  stepFreeWorld(world, 0.05);

  assert.deepEqual(boat.crew, [null, 1]);
  assert.equal(boat.driver, 1);
  assert.equal(world.players[1].mode, "boat");
  assert.equal(world.players[1].activeBoat, boat.id);
  assert.equal(boat.turrets[1].assignedPlayer, 1);
});

test("sinking clears every seat and recovery restores the same registered boat", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  const original = boat;
  boat.driver = 0;
  boat.crew = [0, 1];
  placeAboard(world, 0, boat);
  placeAboard(world, 1, boat);
  boat.sunk = true;
  world.freeDualTurretBoat.recoveryRemaining = 0.04;
  world.freeDualTurretBoat.recoveryWarned30 = true;
  world.freeDualTurretBoat.recoveryWarned10 = true;

  stepFreeWorld(world, 0.05);

  assert.equal(world.boats[boat.id], original);
  assert.equal(boat.sunk, false);
  assert.equal(boat.hull, 300);
  assert.equal(boat.armor, 200);
  assert.equal(boat.driver, null);
  assert.deepEqual(boat.crew, [null, null]);
  assert.equal(world.freeDualTurretBoat.recoveryRemaining, null);
  assert.ok(world.events.some(event => event.type === "dual-turret-recovered"));
});
