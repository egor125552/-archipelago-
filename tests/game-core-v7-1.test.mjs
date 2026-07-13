import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, command, step} from "../public/src/game-core-v7-1.js";

const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let time = 0; time < seconds; time += dt) events.push(...step(state, dt));
  return events;
}

test("safe direct course to the first survivor is not interrupted by a side-obstacle warning", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const survivor = state.world.survivors[0];
  state.boat.heading = bearing(state.boat, survivor);
  state.boat.speed = 4;
  const events = run(state, 2);
  assert.equal(events.some(event => event.type === "hazard-warning"), false);
  assert.match(state.message, /первый человек/i);
});

test("an obstacle directly ahead still produces a warning", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.boat.x = 0;
  state.boat.y = 5;
  state.boat.heading = 0;
  state.boat.speed = 1;
  const events = step(state, 0.05);
  assert.ok(events.some(event => event.type === "hazard-warning"));
  assert.match(state.message, /обломки баржи/i);
});
