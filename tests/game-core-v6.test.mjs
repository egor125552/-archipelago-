import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, getView, CONFIG} from "../public/src/game-core-v6.js";

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...step(state, dt));
  return events;
}

test("boat coasts for a useful time after throttle release", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  // Test hydrodynamic coasting in open water, not the collision response of reef-a.
  state.boat.x = 500;
  state.boat.y = 0;
  state.boat.heading = 0;
  state.boat.speed = 12;
  state.boat.throttle = 0;
  const events = run(state, 10);
  assert.equal(events.some(event => event.type === "collision"), false);
  assert.ok(state.boat.speed > 8.5, `speed was ${state.boat.speed}`);
});

test("sonar gives a steering instruction and shorter cooldown", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  const result = command(state, "sonar");
  assert.equal(result.ok, true);
  assert.ok(state.sonar.cooldown <= CONFIG.sonarCooldown + 0.001);
  assert.match(state.message, /курс|доверни|поворачивай/i);
  assert.ok(state.navigation.lockedTargetId);
});

test("navigation assistant emits spatial target cues", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  command(state, "sonar");
  const events = run(state, 3);
  const cue = events.find(event => event.type === "navigation-cue");
  assert.ok(cue);
  assert.ok(cue.pan >= -1 && cue.pan <= 1);
  assert.ok(cue.distance > 0);
});

test("stationary steering explains why the boat does not turn", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.speed = 0;
  setControl(state, "left", true);
  const events = run(state, 0.1);
  assert.ok(events.some(event => event.type === "steer-no-flow"));
  assert.match(state.message, /дай немного газа/i);
});

test("navigation assistant can be toggled", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  assert.equal(getView(state).navigation.assistEnabled, true);
  command(state, "assist-toggle");
  assert.equal(getView(state).navigation.assistEnabled, false);
});

test("v6 keeps the full rescue and repair loop working", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.boat.hull = 60;
  state.boat.leak = 4;
  state.boat.speed = 0;
  setControl(state, "hullRepair", true);
  let events = run(state, CONFIG.hullRepairDuration + 0.3);
  assert.ok(events.some(event => event.type === "hull-repair-complete"));

  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x;
  state.boat.y = survivor.y;
  state.boat.speed = 0;
  setControl(state, "rescue", true);
  events = run(state, CONFIG.rescueDuration / 1.22 + 0.4);
  assert.equal(survivor.rescued, true);
  assert.ok(events.some(event => event.type === "rescue-complete"));
});
