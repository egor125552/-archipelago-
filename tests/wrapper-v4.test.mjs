import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, step, command, getView} from "../public/src/game-core-v4.js";

function run(state, seconds, dt = 0.05) {
  for (let time = 0; time < seconds; time += dt) step(state, dt);
}

test("free mode has no timeout", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  run(state, 300);
  assert.notEqual(state.ending, "storm");
  assert.equal(getView(state).remaining, null);
});

test("timed mode keeps the four minute ending", () => {
  const state = createGame({mode: "solo", timed: true});
  startGame(state);
  run(state, 241);
  assert.equal(state.ending, "storm");
});

test("steering creates feedback and changes course", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.speed = 1;
  setControl(state, "right", true);
  const events = [];
  for (let time = 0; time < 0.9; time += 0.05) events.push(...step(state, 0.05));
  setControl(state, "right", false);
  events.push(...step(state, 0.05));
  assert.ok(Math.abs(state.boat.heading) > 10);
  assert.ok(events.some(event => event.type === "turn"));
  assert.ok(events.some(event => event.type === "turn-complete"));
});

test("sonar describes an objective and a hazard", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  const result = command(state, "sonar");
  assert.equal(result.ok, true);
  assert.match(state.message, /Цель:/);
  assert.match(state.message, /опасност/i);
});
