import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {prepareDualTurretBoatRoom} from "../public/src/free-roam-dual-turret-boat.js";
import {nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js?v=2";
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";
import {claimVesselDeckResource} from "../public/src/vessel/vessel-deck-runtime.js";

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

test("a surviving crew member stays aboard but does not magically inherit the physical helm", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.driver = 0;
  boat.crew = [0, 1];
  placeAboard(world, 0, boat);
  placeAboard(world, 1, boat);
  const entry = nativeVesselForBoat(world, boat.id);
  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-bridge-deck", x: 0, y: 1.4, heading: 0});
  setVesselOccupantPosition(entry.definition, entry.instance, 1, {deckId: "armored-main-deck", x: 0, y: -4, heading: 0});
  claimVesselDeckResource(entry.instance, 0, "armored-helm-control");
  stepFreeWorld(world, 0.01);
  assert.equal(boat.driver, 0);

  world.players[0].combat.alive = false;
  world.players[0].combat.health = 0;
  world.players[0].mode = "dead";
  world.players[0].activeBoat = null;
  stepFreeWorld(world, 0.05);

  assert.deepEqual(boat.crew, [null, 1]);
  assert.equal(boat.driver, null, "surviving crew must physically occupy the helm instead of receiving it automatically");
  assert.equal(entry.instance.interior.claims["armored-helm-control"], undefined, "dead helm owner must release the station");
  assert.equal(world.players[1].mode, "boat");
  assert.equal(world.players[1].activeBoat, boat.id);
  assert.ok(entry.instance.occupants[1], "surviving crew member remains on a valid deck position");
  assert.equal(boat.turrets[1].assignedPlayer, 1);
});

test("a sunk armored patrol clears its seats and stays sunk until manual merchant recovery", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  const original = boat;
  boat.driver = 0;
  boat.crew = [0, 1];
  placeAboard(world, 0, boat);
  placeAboard(world, 1, boat);

  boat.hull = 0;
  boat.water = 100;
  boat.leak = 16;
  boat.engineStalled = true;
  boat.sunk = true;

  const start = world.events.length;
  stepFreeWorld(world, 0.1);

  assert.equal(world.boats[boat.id], original);
  assert.equal(boat.sunk, true);
  assert.equal(boat.driver, null);
  assert.deepEqual(boat.crew, [null, null]);
  assert.equal(world.freeDualTurretBoat.recoveryRemaining, Number.MAX_SAFE_INTEGER, "legacy automatic recovery must stay locked while merchant recovery owns the lifecycle");
  assert.ok(world.events.slice(start).some(event => event.type === "vessel-manual-recovery-required"));
  assert.equal(world.events.slice(start).some(event => event.type === "dual-turret-recovered"), false);

  for (let index = 0; index < 600; index += 1) stepFreeWorld(world, 0.1);

  assert.equal(world.boats[boat.id], original);
  assert.equal(boat.sunk, true, "the armored patrol must not resurrect automatically after the old sixty-second delay");
  assert.equal(world.freeDualTurretBoat.recoveryRemaining, Number.MAX_SAFE_INTEGER);
  assert.equal(world.events.some(event => event.type === "dual-turret-recovered"), false);
});
