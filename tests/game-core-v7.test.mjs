import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, getView, CONFIG} from "../public/src/game-core-v7.js";

const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let time = 0; time < seconds; time += dt) events.push(...step(state, dt));
  return events;
}

function driveTo(state, target, radius = 5, maxSeconds = 70) {
  const dt = 0.05;
  const events = [];
  let anchorUsed = false;
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += dt) {
    const metres = distance(state.boat, target);
    const relative = wrapDeg(bearing(state.boat, target) - state.boat.heading);
    const speed = Math.abs(state.boat.speed);
    if (metres <= radius && speed <= 2.8) {
      setControl(state, "left", false);
      setControl(state, "right", false);
      setControl(state, "forward", false);
      setControl(state, "reverse", false);
      return {ok: true, events};
    }
    if (metres < 12 && speed > 4 && !anchorUsed) {
      events.push(...command(state, "anchor").events);
      anchorUsed = true;
    }
    let targetSpeed = metres > 25 ? 7 : metres > 12 ? 4.2 : 1.8;
    if (Math.abs(relative) > 55) targetSpeed = Math.min(targetSpeed, 2.2);
    setControl(state, "left", relative < -4);
    setControl(state, "right", relative > 4);
    setControl(state, "forward", state.boat.speed < targetSpeed - 0.3);
    setControl(state, "reverse", state.boat.speed > targetSpeed + 0.8);
    events.push(...step(state, dt));
    if (state.lost) return {ok: false, events};
  }
  return {ok: false, events};
}

function rescue(state) {
  command(state, "anchor");
  run(state, 1);
  setControl(state, "rescue", true);
  const events = run(state, CONFIG.rescueDuration / 1.22 + 0.8);
  setControl(state, "rescue", false);
  return events;
}

test("v7 uses a finite named bay with no hidden current", () => {
  const state = createGame({mode: "solo", timed: false});
  assert.equal(state.world.name, "Бухта Северный Приют");
  assert.deepEqual(state.world.current, {x: 0, y: 0});
  assert.equal(state.world.storm.intensity, 0);
  assert.equal(state.world.bounds.minX, -62);
  assert.equal(state.world.bounds.maxY, 155);
});

test("sonar speaks once and the guide has a forgiving center deadzone", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const result = command(state, "sonar");
  assert.equal(result.ok, true);
  assert.match(state.message, /первый человек/i);
  assert.match(state.message, /57|58/);
  const target = state.world.survivors[0];
  state.boat.heading = bearing(state.boat, target) - 12;
  let view = getView(state);
  assert.equal(view.navigation.guideCentered, true);
  assert.equal(view.navigation.guidePan, 0);
  state.boat.heading -= 20;
  view = getView(state);
  assert.equal(view.navigation.guideCentered, false);
  assert.ok(view.navigation.guidePan > 0);
});

test("passive target and turn cues do not create repeated speech events", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  command(state, "sonar");
  const message = state.message;
  const events = run(state, 3);
  assert.equal(state.message, message);
  assert.equal(events.some(event => ["navigation-cue", "turn", "turn-complete", "turn-progress", "proximity"].includes(event.type)), false);
});

test("wrecks are solid and push the boat outside their collision body", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const wreck = state.world.hazards.find(item => item.id === "wreck-gate");
  state.boat.x = wreck.x;
  state.boat.y = wreck.y - wreck.radius - 1;
  state.boat.heading = 0;
  state.boat.speed = 12;
  const events = step(state, 0.2);
  assert.ok(events.some(event => event.type === "collision"));
  assert.ok(distance(state.boat, wreck) >= wreck.radius + 2.35);
});

test("shoreline makes the map finite", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.boat.x = state.world.bounds.maxX - 0.1;
  state.boat.heading = 90;
  state.boat.speed = 10;
  const events = step(state, 0.2);
  assert.ok(state.boat.x < state.world.bounds.maxX);
  assert.ok(events.some(event => event.type === "collision"));
  assert.match(state.message, /берег бухты/i);
});

test("complete v7 mission is possible with steering, throttle, rope and no teleports", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  let allEvents = [];

  command(state, "sonar");
  let result = driveTo(state, state.world.survivors[0], 6.5);
  allEvents.push(...result.events);
  assert.equal(result.ok, true);
  allEvents.push(...rescue(state));
  assert.equal(state.world.survivors[0].rescued, true);

  command(state, "sonar");
  for (const target of [{x: 25, y: 100}, state.world.survivors[1]]) {
    result = driveTo(state, target, target.id ? 6.5 : 5);
    allEvents.push(...result.events);
    assert.equal(result.ok, true, `failed route to ${JSON.stringify(target)}`);
  }
  allEvents.push(...rescue(state));
  assert.equal(state.world.survivors[1].rescued, true);

  command(state, "sonar");
  for (const target of [{x: 25, y: 100}, {x: 28, y: 55}, {x: 20, y: 22}, state.world.harbor]) {
    result = driveTo(state, target, target.id === "harbor" ? 8 : 5, 80);
    allEvents.push(...result.events);
    if (state.won) break;
    assert.equal(result.ok, true, `failed return route to ${JSON.stringify(target)}`);
  }
  if (!state.won) {
    command(state, "anchor");
    run(state, 2);
  }
  assert.equal(state.won, true);
  assert.equal(state.rescued, 2);
  assert.equal(allEvents.some(event => event.type === "collision"), false);
});
