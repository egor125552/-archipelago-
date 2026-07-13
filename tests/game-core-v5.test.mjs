import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, step, getView, CONFIG} from "../public/src/game-core-v5.js";

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let time = 0; time < seconds; time += dt) events.push(...step(state, dt));
  return events;
}

test("boat keeps useful inertia after releasing throttle", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.speed = 12;
  state.boat.throttle = 0;
  run(state, 2);
  assert.ok(state.boat.speed > 10, `speed was ${state.boat.speed}`);
});

test("reverse remains a deliberate strong brake", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.speed = 12;
  setControl(state, "reverse", true);
  run(state, 2);
  assert.ok(state.boat.speed < 8, `speed was ${state.boat.speed}`);
});

test("hull repair consumes a patch and reduces hull damage and leak", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.hull = 60;
  state.boat.leak = 4;
  state.boat.speed = 0;
  assert.equal(setControl(state, "hullRepair", true), true);
  const events = run(state, CONFIG.hullRepairDuration + 0.2);
  assert.ok(state.boat.hull >= 81);
  assert.ok(state.boat.leak < 1);
  assert.equal(state.boat.repairPatches, 2);
  assert.equal(state.controls.hullRepair, false);
  assert.ok(events.some(event => event.type === "hull-repair-complete"));
});

test("hull repair is blocked while the boat is moving", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.hull = 60;
  state.boat.leak = 4;
  state.boat.speed = 5;
  setControl(state, "hullRepair", true);
  const events = run(state, 1.6);
  assert.equal(state.boat.hull, 60);
  assert.equal(state.boat.repairPatches, 3);
  assert.ok(events.some(event => event.type === "repair-blocked"));
});

test("rescue works at close range and low speed with clear progress", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x;
  state.boat.y = survivor.y;
  state.boat.speed = 0;
  setControl(state, "rescue", true);
  const events = run(state, CONFIG.rescueDuration / 1.22 + 0.25);
  assert.equal(state.rescued, 1);
  assert.equal(state.controls.rescue, false);
  assert.ok(events.some(event => event.type === "rope-progress"));
  assert.ok(events.some(event => event.type === "rescue-complete"));
});

test("rope explains when the survivor is too far away", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  setControl(state, "rescue", true);
  const events = run(state, 1.3);
  assert.equal(state.rescued, 0);
  assert.match(state.message, /Трос не достаёт/);
  assert.ok(events.some(event => event.type === "rope-far"));
});

test("coop hull repair belongs to the systems operator", () => {
  const state = createGame({mode: "coop"});
  startGame(state);
  state.boat.hull = 70;
  state.boat.leak = 2;
  assert.equal(setControl(state, "hullRepair", true, "captain"), false);
  assert.equal(setControl(state, "hullRepair", true, "crew"), true);
});

test("short steering pulse changes the course clearly", () => {
  const state = createGame({mode: "solo"});
  startGame(state);
  state.boat.speed = 1;
  setControl(state, "right", true);
  const events = run(state, 1.1);
  setControl(state, "right", false);
  events.push(...step(state, 0.05));
  assert.ok(Math.abs(state.boat.heading) > 15, `heading was ${state.boat.heading}`);
  assert.ok(events.some(event => event.type === "turn-progress"));
  assert.ok(getView(state).boat.rudder != null);
});
