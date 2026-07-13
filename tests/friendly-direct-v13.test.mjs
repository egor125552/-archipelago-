import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG,
  command,
  createGame,
  getRoutePlan,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v11.js";

const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
  }
  return events;
}

function approachWithCourseHold(state, target, initialError = 8, maxSeconds = 120) {
  state.boat.heading = wrap(bearing(state.boat, target) + initialError);
  setControl(state, "forward", true);
  const events = [];
  for (let elapsed = 0; elapsed < maxSeconds && state.phase === "playing"; elapsed += 0.05) {
    events.push(...step(state, 0.05));
    if (target.id !== "harbor" && getView(state).navigation.rescueMode) {
      setControl(state, "forward", false);
      return {ok: true, events};
    }
    if (target.id === "harbor" && state.won) return {ok: true, events};
  }
  setControl(state, "forward", false);
  return {ok: false, events};
}

function segmentDistance(start, end, point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const raw = lengthSquared > 0
    ? ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
    : 0;
  const amount = Math.max(0, Math.min(1, raw));
  return Math.hypot(start.x + dx * amount - point.x, start.y + dy * amount - point.y);
}

test("sonar points directly at the objective with no hidden waypoint", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const result = command(state, "sonar");
  const view = getView(state);
  const plan = getRoutePlan(state, "survivor-a");

  assert.equal(result.ok, true);
  assert.equal(view.navigation.directMode, true);
  assert.equal(view.navigation.guideIsWaypoint, false);
  assert.equal(view.navigation.routeWaypointId, "survivor-a");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, "survivor-a");
  assert.match(state.message, /прямой свободный курс/i);
  assert.doesNotMatch(state.message, /контрольн/i);
});

test("centering acquires course hold and removes residual rudder drift", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const target = state.world.survivors[0];
  state.boat.heading = bearing(state.boat, target) - 8;
  state.boat.rudder = 1;
  setControl(state, "forward", true);

  const before = Math.abs(wrap(bearing(state.boat, target) - state.boat.heading));
  const events = step(state, 0.05);
  const after = Math.abs(wrap(bearing(state.boat, target) - state.boat.heading));

  assert.equal(getView(state).navigation.courseHold, true);
  assert.equal(state.boat.rudder, 0);
  assert.ok(after < before, `course error did not shrink: ${before} -> ${after}`);
  assert.ok(events.some(event => event.type === "course-hold"));
  assert.match(state.message, /курс на цель захвачен/i);
});

test("turning the navigation assistant off also releases automatic course hold", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const target = state.world.survivors[0];
  state.boat.heading = bearing(state.boat, target);
  setControl(state, "forward", true);
  step(state, 0.05);
  assert.equal(getView(state).navigation.courseHold, true);

  command(state, "assist-toggle");
  step(state, 0.05);
  assert.equal(getView(state).navigation.courseHold, false);
});

test("held course reaches the rope zone without any further steering", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const target = state.world.survivors[0];
  const approach = approachWithCourseHold(state, target, 9.5);
  const view = getView(state);

  assert.equal(approach.ok, true);
  assert.equal(approach.events.some(event => event.type === "collision"), false);
  assert.equal(view.navigation.courseHold, true);
  assert.equal(view.navigation.rescueMode, true);
  assert.equal(view.navigation.beaconSuppressed, true);
  assert.ok(distance(state.boat, target) <= CONFIG.rescueRadius);
  assert.ok(Math.abs(state.boat.speed) <= CONFIG.rescueSpeedLimit);
});

test("course hold remains exact under uneven mobile frame intervals", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const target = state.world.survivors[0];
  state.boat.heading = bearing(state.boat, target) + 9.5;
  setControl(state, "forward", true);
  const intervals = [0.016, 0.033, 0.1, 0.05, 0.2];
  const events = [];
  for (let frame = 0; frame < 3000 && !getView(state).navigation.rescueMode; frame += 1) {
    events.push(...step(state, intervals[frame % intervals.length]));
  }

  const view = getView(state);
  assert.equal(view.navigation.rescueMode, true);
  assert.equal(view.navigation.courseHold, true);
  assert.ok(distance(state.boat, target) <= CONFIG.rescueRadius);
  assert.equal(events.some(event => event.type === "collision"), false);
});

test("all required direct legs have wide clearance from bank hazards", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const legs = [
    [state.world.harbor, state.world.survivors[0]],
    [state.world.survivors[0], state.world.survivors[1]],
    [state.world.survivors[1], state.world.harbor],
  ];

  for (const [start, end] of legs) {
    for (const hazard of state.world.hazards) {
      const clearance = segmentDistance(start, end, hazard) - hazard.radius - CONFIG.collisionMargin;
      assert.ok(clearance > 15, `${start.id}->${end.id} is only ${clearance.toFixed(2)}m from ${hazard.id}`);
    }
  }
  assert.ok(state.world.hazards.every(hazard => Math.abs(hazard.x) >= 45));
});

test("simple center, gas, rope flow completes the whole game", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const events = [];

  for (const targetId of ["survivor-a", "survivor-b"]) {
    state.sonar.cooldown = 0;
    command(state, "sonar");
    const target = state.world.survivors.find(item => item.id === targetId);
    const approach = approachWithCourseHold(state, target, targetId === "survivor-a" ? -9 : 9);
    events.push(...approach.events);
    assert.equal(approach.ok, true, `failed direct approach to ${targetId}`);
    setControl(state, "rescue", true);
    events.push(...run(state, 3));
    assert.equal(target.rescued, true);
  }

  state.sonar.cooldown = 0;
  command(state, "sonar");
  const docking = approachWithCourseHold(state, state.world.harbor, -9.5);
  events.push(...docking.events);

  assert.equal(docking.ok, true);
  assert.equal(state.won, true);
  assert.equal(state.rescued, 2);
  assert.equal(events.some(event => event.type === "collision"), false);
  assert.equal(events.some(event => event.type === "route-advance"), false);
  assert.equal(events.filter(event => event.type === "course-hold").length, 3);
  assert.ok(events.filter(event => event.type === "approach-assist").length >= 2);
  assert.ok(events.some(event => event.type === "docking-assist"));
});
