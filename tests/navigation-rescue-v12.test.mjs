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
} from "../public/src/game-core-v10.js";
import {AudioEngine} from "../public/src/audio-engine-v9.js";

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

function setDrive(state, {left = false, right = false, forward = false, reverse = false} = {}) {
  setControl(state, "left", left);
  setControl(state, "right", right);
  setControl(state, "forward", forward);
  setControl(state, "reverse", reverse);
}

function driveTo(state, target, radius = 4, maxSeconds = 100) {
  const events = [];
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 0.05) {
    const metres = distance(state.boat, target);
    const relative = wrap(bearing(state.boat, target) - state.boat.heading);
    const speed = Math.abs(state.boat.speed);
    if (metres <= radius && speed <= 3) {
      setDrive(state);
      return {ok: true, events};
    }
    let targetSpeed = metres > 25 ? 6 : metres > 12 ? 3.8 : 1.8;
    if (Math.abs(relative) > 50) targetSpeed = Math.min(targetSpeed, 2);
    setDrive(state, {
      left: relative < -4,
      right: relative > 4,
      forward: state.boat.speed < targetSpeed - 0.3,
      reverse: state.boat.speed > targetSpeed + 0.8,
    });
    events.push(...step(state, 0.05));
    if (state.lost || state.won) return {ok: false, events};
  }
  setDrive(state);
  return {ok: false, events};
}

function followAudibleBeacon(state, {untilRescue = false, maxSeconds = 140} = {}) {
  const events = [];
  for (let elapsed = 0; elapsed < maxSeconds && state.phase === "playing"; elapsed += 0.05) {
    const view = getView(state);
    if (untilRescue && view.navigation.rescueMode) {
      setDrive(state);
      return {ok: true, events};
    }
    const relative = view.navigation.targetRelativeAngle;
    const metres = view.navigation.guideDistance;
    if (!Number.isFinite(relative) || !Number.isFinite(metres)) return {ok: false, events};
    let targetSpeed = metres > 25 ? 6 : metres > 12 ? 3.8 : 1.7;
    if (Math.abs(relative) > 50) targetSpeed = Math.min(targetSpeed, 2);
    setDrive(state, {
      left: relative < -4,
      right: relative > 4,
      forward: state.boat.speed < targetSpeed - 0.3,
      reverse: state.boat.speed > targetSpeed + 0.8,
    });
    events.push(...step(state, 0.05));
    if (state.won) return {ok: true, events};
    if (state.lost) return {ok: false, events};
  }
  setDrive(state);
  return {ok: state.won, events};
}

function segmentDistance(start, end, point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared > 0
    ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
    : 0;
  return Math.hypot(start.x + dx * amount - point.x, start.y + dy * amount - point.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

test("rope at thirteen metres suppresses the beacon and holds the boat until rescue", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x;
  state.boat.y = survivor.y - 13;
  state.boat.speed = 3.5;

  let view = getView(state);
  assert.equal(view.navigation.rescueMode, true);
  assert.equal(view.navigation.beaconSuppressed, true);
  assert.equal(setControl(state, "rescue", true), true);
  assert.equal(state.boat.speed, 0);
  assert.equal(state.controls.forward, false);

  const events = run(state, 3);
  view = getView(state);
  assert.equal(state.rescued, 1);
  assert.equal(state.controls.rescue, false);
  assert.equal(events.some(event => event.type === "rope-far"), false);
  assert.ok(events.some(event => event.type === "rescue-complete"));
  assert.equal(view.navigation.lockedTargetId, null);
});

test("route changes only after reaching a checkpoint and pauses the new beacon", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const first = getRoutePlan(state, "survivor-a")[0];
  assert.equal(getView(state).navigation.routeWaypointId, first.id);

  state.boat.x = first.x;
  state.boat.y = first.y;
  const events = step(state, 0.05);
  const view = getView(state);

  assert.ok(events.some(event => event.type === "route-advance"));
  assert.match(state.message, /переключается только сейчас/i);
  assert.equal(view.navigation.routeWaypointId, "survivor-a");
  assert.equal(view.navigation.routeAnnouncement, true);
  assert.equal(view.navigation.beaconSuppressed, true);

  run(state, 1.7);
  assert.equal(getView(state).navigation.routeAnnouncement, false);
});

test("audio engine emits no moving beacon while rope capture is available", () => {
  const engine = new AudioEngine();
  engine.ctx = {currentTime: 10};
  engine.nextGuidePipAt = 0;
  let pips = 0;
  engine.playSynthPip = () => { pips += 1; };
  engine.playGuide({
    navigation: {
      assistEnabled: true,
      lockedTargetId: "survivor-a",
      guideDistance: 13,
      guideCentered: false,
      guidePan: 0.8,
      beaconSuppressed: true,
      rescueMode: true,
    },
  });
  assert.equal(pips, 0);
});

test("curated route segments keep generous clearance from every solid hazard", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const cases = [
    {target: "survivor-a", start: {x: 0, y: 0}, rescued: 0},
    {target: "survivor-b", start: {x: 28, y: 50}, rescued: 1},
    {target: "harbor", start: {x: -27, y: 132}, rescued: 2},
  ];

  for (const routeCase of cases) {
    state.rescued = routeCase.rescued;
    state.world.survivors[0].rescued = routeCase.rescued >= 1;
    state.world.survivors[1].rescued = routeCase.rescued >= 2;
    let previous = routeCase.start;
    for (const point of getRoutePlan(state, routeCase.target)) {
      for (const hazard of state.world.hazards) {
        const clearance = segmentDistance(previous, point, hazard) - hazard.radius - CONFIG.collisionMargin;
        assert.ok(clearance > 5, `${routeCase.target} segment to ${point.id} passes ${hazard.id} with ${clearance.toFixed(2)}m`);
      }
      previous = point;
    }
  }
});

test("old coordinate thresholds cannot silently flip the harbor waypoint", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.world.survivors.forEach(item => { item.rescued = true; });
  state.rescued = 2;
  state.boat.x = 20;
  state.boat.y = 59;
  state.boat.heading = 180;
  command(state, "sonar");
  const before = getView(state).navigation.routeWaypointId;

  state.boat.y = 57;
  const after = getView(state).navigation.routeWaypointId;

  assert.equal(before, "north-return-gate");
  assert.equal(after, before);
});

test("location report names the current safe waypoint instead of contradicting the beacon", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const report = command(state, "where");
  assert.equal(report.ok, true);
  assert.match(state.message, /текущий безопасный ориентир маяка/i);
  assert.match(state.message, /восточный коридор/i);
});

test("complete production route rescues both people and docks without collision", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const events = [];

  for (const targetId of ["survivor-a", "survivor-b", "harbor"]) {
    state.sonar.cooldown = 0;
    command(state, "sonar");
    for (const target of getRoutePlan(state, targetId)) {
      const result = driveTo(state, target, targetId === "harbor" && target.id === "harbor" ? 8 : 4);
      events.push(...result.events);
      if (state.won) break;
      assert.equal(result.ok, true, `failed ${targetId} at ${target.id}`);
    }
    if (targetId !== "harbor") {
      assert.equal(getView(state).navigation.rescueMode, true);
      setControl(state, "rescue", true);
      events.push(...run(state, 3));
      assert.equal(state.world.survivors.find(item => item.id === targetId).rescued, true);
    }
  }

  if (!state.won) events.push(...run(state, 3));
  assert.equal(state.won, true);
  assert.equal(state.rescued, 2);
  assert.equal(events.some(event => event.type === "collision"), false);
  assert.equal(events.filter(event => event.type === "route-advance").length, 7);
  assert.ok(events.some(event => event.type === "docking-assist"));
});

test("the same audible bearing available to the player completes the whole mission", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const events = [];

  for (const targetId of ["survivor-a", "survivor-b"]) {
    state.sonar.cooldown = 0;
    command(state, "sonar");
    const approach = followAudibleBeacon(state, {untilRescue: true});
    events.push(...approach.events);
    assert.equal(approach.ok, true, `audible approach failed for ${targetId}`);
    assert.equal(getView(state).navigation.beaconSuppressed, true);
    setControl(state, "rescue", true);
    events.push(...run(state, 3));
    assert.equal(state.world.survivors.find(item => item.id === targetId).rescued, true);
  }

  state.sonar.cooldown = 0;
  command(state, "sonar");
  const docking = followAudibleBeacon(state);
  events.push(...docking.events);

  assert.equal(docking.ok, true);
  assert.equal(state.won, true);
  assert.equal(events.some(event => event.type === "collision"), false);
  assert.ok(events.some(event => event.type === "docking-assist"));
});
