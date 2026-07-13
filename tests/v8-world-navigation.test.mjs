import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, getView, CONFIG} from "../public/src/game-core-v8.js";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let time = 0; time < seconds; time += dt) events.push(...step(state, dt));
  return events;
}

function setDrive(state, {left = false, right = false, forward = false, reverse = false} = {}) {
  setControl(state, "left", left);
  setControl(state, "right", right);
  setControl(state, "forward", forward);
  setControl(state, "reverse", reverse);
}

function driveTo(state, target, radius = 5.5, maxSeconds = 45) {
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 0.05) {
    const metres = distance(state.boat, target);
    const relative = wrap(bearing(state.boat, target) - state.boat.heading);
    const speed = Math.abs(state.boat.speed);
    if (metres <= radius && speed <= 3.1) {
      setDrive(state);
      return true;
    }
    if (metres < 11 && speed > 4.2) command(state, "anchor");
    const targetSpeed = metres > 22 ? 6.2 : metres > 11 ? 3.8 : 1.6;
    setDrive(state, {
      left: relative < -4,
      right: relative > 4,
      forward: state.boat.speed < targetSpeed - 0.3,
      reverse: state.boat.speed > targetSpeed + 0.8,
    });
    step(state, 0.05);
    if (state.lost || state.won) return false;
  }
  setDrive(state);
  return false;
}

test("the mission uses a finite named bay", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  assert.equal(state.world.name, "Бухта Северный Приют");
  assert.ok(state.world.bounds.minX < state.boat.x && state.boat.x < state.world.bounds.maxX);
  assert.ok(state.world.bounds.minY < state.boat.y && state.boat.y < state.world.bounds.maxY);
  const view = getView(state);
  assert.equal(view.location.zone, "Южная гавань");
  assert.match(view.location.description, /стартовая гавань/i);
});

test("sonar speaks once and the beacon follows boat heading", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const result = command(state, "sonar");
  assert.equal(result.ok, true);
  assert.match(state.message, /первый человек/i);
  const snapshot = state.message;

  let view = getView(state);
  assert.ok(view.navigation.beaconPan > 0, `expected target on right, pan=${view.navigation.beaconPan}`);
  assert.equal(view.navigation.beaconCentered, false);

  state.boat.heading = bearing(state.boat, state.world.survivors[0]);
  view = getView(state);
  assert.equal(view.navigation.beaconPan, 0);
  assert.equal(view.navigation.beaconCentered, true);

  state.boat.heading += 30;
  view = getView(state);
  assert.ok(view.navigation.beaconPan < 0, `expected target on left, pan=${view.navigation.beaconPan}`);

  const passiveEvents = run(state, 4);
  assert.equal(state.message, snapshot);
  assert.equal(passiveEvents.some(event => ["navigation-cue", "zone-enter", "hazard-warning"].includes(event.type)), false);
});

test("location report explains zone, target, shore and obstacle", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const report = command(state, "where");
  assert.equal(report.ok, true);
  assert.match(state.message, /Южная гавань/i);
  assert.match(state.message, /первый человек/i);
  assert.match(state.message, /берег/i);
  assert.match(state.message, /препятств/i);
});

test("wreck remains solid and cannot be crossed while throttle is held", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const wreck = state.world.hazards.find(item => item.id === "wreck-gate");
  state.boat.x = wreck.x;
  state.boat.y = wreck.y - wreck.radius - CONFIG.collisionMargin - 2;
  state.boat.heading = 0;
  state.boat.speed = 8;
  setControl(state, "forward", true);
  const events = run(state, 4);
  setControl(state, "forward", false);
  assert.ok(events.some(event => event.type === "collision"));
  assert.ok(state.boat.y < wreck.y, `boat crossed wreck: y=${state.boat.y}`);
  assert.ok(distance(state.boat, wreck) >= wreck.radius + CONFIG.collisionMargin - 0.1);
});

test("first survivor is reachable and rescuable with ordinary controls", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const survivor = state.world.survivors[0];
  const route = [{x: 13, y: 18}, {x: 25, y: 38}, {x: survivor.x, y: survivor.y}];
  for (const waypoint of route) {
    assert.equal(driveTo(state, waypoint, waypoint === route.at(-1) ? 8.5 : 5.2), true,
      `failed at ${JSON.stringify(waypoint)} boat=${JSON.stringify({x: state.boat.x, y: state.boat.y, speed: state.boat.speed, heading: state.boat.heading})}`);
  }
  assert.ok(distance(state.boat, survivor) <= 12);
  command(state, "anchor");
  run(state, 1);
  setControl(state, "rescue", true);
  const events = run(state, 4);
  setControl(state, "rescue", false);
  assert.equal(survivor.rescued, true);
  assert.ok(events.some(event => event.type === "rescue-complete"));
});
