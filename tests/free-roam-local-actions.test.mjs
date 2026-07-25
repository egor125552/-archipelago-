import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLocalActionPrediction,
  createLocalActionPrediction,
  localActionPredictionExpired,
} from "../public/src/free-roam-local-actions.js";

function worldFixture() {
  return {
    time: 10,
    players: [
      {
        id: 0,
        mode: "foot",
        activeBoat: null,
        x: 100,
        y: 100,
        heading: 0,
        airborne: false,
        jumpHeight: 0,
        combat: {alive: true, knockedDown: false, carriedCrate: null},
      },
      {
        id: 1,
        mode: "foot",
        activeBoat: null,
        x: 200,
        y: 200,
        heading: 0,
        combat: {alive: true, knockedDown: false, carriedCrate: null},
      },
    ],
    boats: [
      {
        id: 0,
        owner: 0,
        driver: 0,
        x: 160,
        y: 160,
        heading: 0,
        speed: 8,
        throttle: 1,
        rudder: 0.4,
        floatingBrakeReadyAt: 0,
        cargo: [],
        sunk: false,
      },
    ],
    freeActivities: {
      presence: [true, false],
      crates: [
        {
          id: "crate-test",
          kind: "valuable",
          label: "тестовый ящик",
          slots: 1,
          state: "world",
          carriedBy: null,
          stowedBoat: null,
          x: 102,
          y: 100,
        },
      ],
    },
  };
}

test("local foot jump starts immediately and follows the local arc", () => {
  const world = worldFixture();
  const prediction = createLocalActionPrediction(world, 0, "jump", 1_000);
  assert.equal(prediction.type, "jump");
  assert.equal(applyLocalActionPrediction(world, prediction, 1_000), true);
  assert.equal(world.players[0].airborne, true);
  assert.ok(world.players[0].jumpHeight >= 0.04);
  applyLocalActionPrediction(world, prediction, 1_900);
  assert.equal(world.players[0].airborne, false);
  assert.equal(world.players[0].jumpHeight, 0);
});

test("local floating brake cuts rendered boat speed without waiting for the server", () => {
  const world = worldFixture();
  world.players[0].mode = "boat";
  world.players[0].activeBoat = 0;
  const prediction = createLocalActionPrediction(world, 0, "jump", 2_000);
  assert.equal(prediction.type, "brake");
  assert.equal(applyLocalActionPrediction(world, prediction, 2_000), true);
  assert.ok(Math.abs(world.boats[0].speed) <= 0.12);
  assert.equal(world.boats[0].throttle, 0);
  assert.equal(world.boats[0].rudder, 0);
  assert.equal(world.boats[0].floatingBrakeReadyAt, 22);
});

test("nearby cargo is picked up and then stowed locally", () => {
  const world = worldFixture();
  const pickup = createLocalActionPrediction(world, 0, "action", 3_000);
  assert.equal(pickup.type, "cargo-pickup");
  assert.equal(applyLocalActionPrediction(world, pickup, 3_000), true);
  assert.equal(world.players[0].combat.carriedCrate, "crate-test");
  assert.equal(world.freeActivities.crates[0].state, "carried");

  world.players[0].x = 160;
  world.players[0].y = 168;
  const stow = createLocalActionPrediction(world, 0, "action", 3_100);
  assert.equal(stow.type, "cargo-stow");
  assert.equal(applyLocalActionPrediction(world, stow, 3_100), true);
  assert.equal(world.players[0].combat.carriedCrate, null);
  assert.deepEqual(world.boats[0].cargo, ["crate-test"]);
  assert.equal(world.freeActivities.crates[0].state, "stowed");
});

test("prediction expiry prevents stale optimistic actions surviving reconnects", () => {
  const prediction = {startedAtMs: 1_000, expiryMs: 1_500};
  assert.equal(localActionPredictionExpired(prediction, 2_400), false);
  assert.equal(localActionPredictionExpired(prediction, 2_501), true);
});
