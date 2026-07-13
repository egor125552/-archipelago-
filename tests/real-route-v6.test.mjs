import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, CONFIG} from "../public/src/game-core-v6.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function setDrive(state, {left = false, right = false, forward = false, reverse = false} = {}) {
  setControl(state, "left", left);
  setControl(state, "right", right);
  setControl(state, "forward", forward);
  setControl(state, "reverse", reverse);
}

function stopDrive(state) {
  setDrive(state);
}

function driveTo(state, target, options = {}) {
  const radius = options.radius ?? 4.2;
  const maxSeconds = options.maxSeconds ?? 55;
  const dt = 0.05;
  let usedAnchor = false;
  const events = [];

  for (let elapsed = 0; elapsed < maxSeconds; elapsed += dt) {
    const metres = distance(state.boat, target);
    const relative = wrapDeg(bearing(state.boat, target) - state.boat.heading);
    const absRelative = Math.abs(relative);
    const speed = Math.abs(state.boat.speed);

    if (metres <= radius && speed <= 2.4) {
      stopDrive(state);
      return {ok: true, elapsed, events};
    }

    if (metres < 10 && speed > 4.2 && !usedAnchor) {
      events.push(...command(state, "anchor").events);
      usedAnchor = true;
    }

    let targetSpeed = metres > 26 ? 7.2 : metres > 13 ? 4.8 : 2.0;
    if (absRelative > 72) targetSpeed = Math.min(targetSpeed, 2.2);
    else if (absRelative > 38) targetSpeed = Math.min(targetSpeed, 3.5);

    const turnDeadzone = metres < 7 ? 8 : 4;
    const right = relative > turnDeadzone;
    const left = relative < -turnDeadzone;
    const forward = state.boat.speed < targetSpeed - 0.35;
    const reverse = state.boat.speed > targetSpeed + 0.85;

    setDrive(state, {left, right, forward, reverse});
    events.push(...step(state, dt));

    if (state.lost || state.won) {
      stopDrive(state);
      return {ok: false, elapsed, events};
    }
  }

  stopDrive(state);
  return {ok: false, elapsed: maxSeconds, events};
}

function rescueCurrentTarget(state) {
  command(state, "anchor");
  for (let i = 0; i < 20; i += 1) step(state, 0.05);
  setControl(state, "rescue", true);
  const events = [];
  for (let time = 0; time < CONFIG.rescueDuration / 1.22 + 1.2; time += 0.05) {
    events.push(...step(state, 0.05));
    if (events.some(event => event.type === "rescue-complete")) break;
  }
  setControl(state, "rescue", false);
  return events;
}

test("complete real route uses normal controls with no teleports", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);

  const routeToFirst = [
    {x: 35, y: 55},
    {x: 38, y: 90},
    {x: 25, y: 116},
    {x: 20, y: 122},
  ];
  const routeToSecond = [
    {x: -32, y: 140},
    {x: -30, y: 178},
    {x: -22, y: 188},
  ];
  const routeToHarbor = [
    {x: -30, y: 215},
    {x: 0, y: 240},
  ];

  let allEvents = [];
  let sonar = command(state, "sonar");
  assert.equal(sonar.ok, true);
  assert.equal(state.sonar.lastResult.kind, "человек");

  for (const waypoint of routeToFirst) {
    const result = driveTo(state, waypoint, {radius: waypoint === routeToFirst.at(-1) ? 6.2 : 4.5});
    allEvents.push(...result.events);
    assert.equal(result.ok, true, `failed first route at ${JSON.stringify(waypoint)}, boat=${JSON.stringify({x: state.boat.x, y: state.boat.y, speed: state.boat.speed, heading: state.boat.heading})}`);
  }
  assert.ok(distance(state.boat, state.world.survivors[0]) <= CONFIG.rescueRadius);
  allEvents.push(...rescueCurrentTarget(state));
  assert.equal(state.world.survivors[0].rescued, true);
  assert.equal(state.rescued, 1);

  state.sonar.cooldown = 0;
  sonar = command(state, "sonar");
  assert.equal(sonar.ok, true);
  assert.equal(state.sonar.lastResult.kind, "человек");

  for (const waypoint of routeToSecond) {
    const result = driveTo(state, waypoint, {radius: waypoint === routeToSecond.at(-1) ? 6.2 : 4.5});
    allEvents.push(...result.events);
    assert.equal(result.ok, true, `failed second route at ${JSON.stringify(waypoint)}, boat=${JSON.stringify({x: state.boat.x, y: state.boat.y, speed: state.boat.speed, heading: state.boat.heading})}`);
  }
  assert.ok(distance(state.boat, state.world.survivors[1]) <= CONFIG.rescueRadius);
  allEvents.push(...rescueCurrentTarget(state));
  assert.equal(state.world.survivors[1].rescued, true);
  assert.equal(state.rescued, 2);

  state.sonar.cooldown = 0;
  sonar = command(state, "sonar");
  assert.equal(sonar.ok, true);
  assert.equal(state.sonar.lastResult.kind, "гавань");

  for (const waypoint of routeToHarbor) {
    const result = driveTo(state, waypoint, {radius: waypoint === routeToHarbor.at(-1) ? 8 : 4.5, maxSeconds: 70});
    allEvents.push(...result.events);
    if (state.won) break;
    assert.equal(result.ok, true, `failed harbor route at ${JSON.stringify(waypoint)}, boat=${JSON.stringify({x: state.boat.x, y: state.boat.y, speed: state.boat.speed, heading: state.boat.heading})}`);
  }

  if (!state.won) {
    command(state, "anchor");
    for (let i = 0; i < 40 && !state.won; i += 1) step(state, 0.05);
  }

  assert.equal(state.won, true);
  assert.equal(state.ending, "harbor");
  assert.equal(allEvents.some(event => event.type === "collision"), false);
  assert.ok(state.elapsed > 20);
  assert.ok(state.elapsed < 240);
});
