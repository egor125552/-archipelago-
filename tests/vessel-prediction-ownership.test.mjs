import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {predictLocalWorld} from "../public/src/free-roam-client-prediction.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication-v2.js";
import {
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_REVERSE_SPEED,
  STRESS_TEST_VESSEL_TYPE,
} from "../public/src/vessel/stress-test-vessel-config.js";

function stressBoat(world) {
  return world.boats.find(boat => boat?.boatType === STRESS_TEST_VESSEL_TYPE);
}

function putPlayerBesideBoat(world, playerIndex, boat, offset = 0) {
  const player = world.players[playerIndex];
  player.mode = "swim";
  player.activeBoat = null;
  player.x = boat.x + offset;
  player.y = boat.y;
  player.heading = boat.heading;
}

test("modular vessel prediction uses the server physics hint instead of standard boat limits", () => {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.04);
  const boat = stressBoat(world);
  assert.ok(boat);
  assert.equal(boat.predictionPhysicsProfile.maxForwardSpeed, STRESS_TEST_MAX_SPEED);
  assert.equal(boat.predictionPhysicsProfile.maxReverseSpeed, STRESS_TEST_REVERSE_SPEED);
  assert.equal(boat.predictionPhysicsProfile.acceleration, 92);
  assert.equal(boat.predictionPhysicsProfile.deceleration, 118);
  assert.equal(boat.predictionPhysicsProfile.releaseBehavior, "target-zero");
  assert.equal(boat.predictionPhysicsProfile.applyDrag, false);

  const snapshot = replicatedFreeWorld(world);
  const replicatedBoat = snapshot.boats[boat.id];
  assert.equal(replicatedBoat.predictionPhysicsProfile.maxForwardSpeed, STRESS_TEST_MAX_SPEED);
  assert.equal(replicatedBoat.predictionPhysicsProfile.deceleration, 118);

  replicatedBoat.owner = 0;
  replicatedBoat.driver = 0;
  replicatedBoat.speed = 60;
  replicatedBoat.throttle = 1;
  snapshot.players[0].mode = "boat";
  snapshot.players[0].activeBoat = replicatedBoat.id;
  snapshot.players[0].x = replicatedBoat.x;
  snapshot.players[0].y = replicatedBoat.y;
  predictLocalWorld(snapshot, 0, {up: true}, 0.04);
  assert.ok(replicatedBoat.speed > 21, "module vessel prediction must not clamp to the standard boat maximum");
  assert.ok(replicatedBoat.speed <= STRESS_TEST_MAX_SPEED);
});

test("first driver claims a neutral single-seat vessel and the other player then sees it as someone else's", () => {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.04);
  const boat = world.boats.find(candidate => candidate?.vesselInstanceId && Math.max(1, Number(candidate.crewCapacity) || 1) === 1);
  assert.ok(boat, "the world must contain a registered single-seat vessel for the ownership contract");
  assert.notEqual(boat.boatType, STRESS_TEST_VESSEL_TYPE, "the two-seat stress vessel must not be used as a single-seat ownership fixture");
  boat.owner = null;
  boat.driver = null;
  boat.crew = [];
  boat.reserved = false;
  for (const candidate of world.boats) if (candidate && candidate !== boat) candidate.reserved = true;

  putPlayerBesideBoat(world, 0, boat);
  putPlayerBesideBoat(world, 1, boat, 40);
  drainEvents(world);
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.04);

  assert.equal(world.players[0].activeBoat, boat.id);
  assert.equal(boat.owner, 0);
  const firstEnter = drainEvents(world).find(event => event.type === "enter" && event.sourcePlayer === 0);
  assert.ok(firstEnter);
  assert.equal(firstEnter.claimedBoat, true);
  assert.equal(firstEnter.ownedBoat, true);
  assert.equal(firstEnter.ownerPlayer, 0);
  assert.doesNotMatch(firstEnter.text, /чуж|другого игрока/i);

  boat.driver = null;
  boat.crew = [];
  world.players[0].mode = "swim";
  world.players[0].activeBoat = null;
  world.players[0].x = boat.x + 40;
  world.players[0].y = boat.y;
  putPlayerBesideBoat(world, 1, boat);
  setPlayerInput(world, 0, {action: false});
  setPlayerInput(world, 1, {action: true});
  stepFreeWorld(world, 0.04);

  assert.equal(world.players[1].activeBoat, boat.id);
  assert.equal(boat.owner, 0, "second driver must not silently steal vessel ownership");
  const secondEnter = drainEvents(world).find(event => event.type === "enter" && event.sourcePlayer === 1);
  assert.ok(secondEnter);
  assert.equal(secondEnter.claimedBoat, false);
  assert.equal(secondEnter.ownedBoat, false);
  assert.equal(secondEnter.ownerPlayer, 0);
  assert.match(secondEnter.text, /другого игрока/i);
});
