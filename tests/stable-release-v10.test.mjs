import test from "node:test";
import assert from "node:assert/strict";
import {stat} from "node:fs/promises";

import {
  CONFIG,
  command,
  createGame,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v9-1.js";
import {AudioEngine, floodMuffleCutoff} from "../public/src/audio-engine-v9.js";

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

function enterFloodEmergency(state, {hull = 58, leak = 4} = {}) {
  state.boat.hull = hull;
  state.boat.water = 99.8;
  state.boat.leak = leak;
  step(state, 0.25);
  assert.equal(getView(state).damageControl.floodEmergency, true);
}

function driveTo(state, target, radius = 5, maxSeconds = 75) {
  let anchorUsed = false;
  const events = [];
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 0.05) {
    const metres = distance(state.boat, target);
    const relative = wrap(bearing(state.boat, target) - state.boat.heading);
    const speed = Math.abs(state.boat.speed);
    if (metres <= radius && speed <= 2.8) {
      for (const control of ["left", "right", "forward", "reverse"]) setControl(state, control, false);
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
    events.push(...step(state, 0.05));
    if (state.lost || state.won) return {ok: false, events};
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

test("sonar direction and stereo beacon both point to the safe route", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.world.survivors[0].rescued = true;
  state.rescued = 1;
  state.boat.x = 28;
  state.boat.y = 50;

  const second = state.world.survivors[1];
  state.boat.heading = bearing(state.boat, second);
  assert.ok(Math.abs(wrap(bearing(state.boat, second) - state.boat.heading)) < 0.01);

  const result = command(state, "sonar");
  const view = getView(state);
  const sonar = result.events.find(event => event.type === "sonar");
  const lock = result.events.find(event => event.type === "sonar-lock");

  assert.equal(result.ok, true);
  assert.equal(view.navigation.guideIsWaypoint, true);
  assert.ok(view.navigation.beaconPan > 0.05, `beacon pan=${view.navigation.beaconPan}`);
  assert.ok(sonar.pan > 0.05, `sonar pan=${sonar.pan}`);
  assert.ok(lock.pan > 0.05, `lock pan=${lock.pan}`);
  assert.match(state.message, /безопасн(ый|ого) проход/i);
  assert.match(state.message, /справа|вправо/i);
  assert.doesNotMatch(state.message, /маршрут прямо/i);
});

test("the beacon does not abandon the safe north gate at an invisible Y threshold", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.world.survivors[0].rescued = true;
  state.rescued = 1;
  state.boat.x = 10;
  state.boat.y = 90;
  state.boat.heading = bearing(state.boat, state.world.survivors[1]);

  command(state, "sonar");
  const view = getView(state);
  assert.equal(view.navigation.guideIsWaypoint, true);
  assert.equal(view.navigation.targetLabel, "второй человек");
  assert.ok(view.navigation.beaconPan > 0.05, `beacon pan=${view.navigation.beaconPan}`);
  assert.match(state.message, /безопасный проход/i);
});

test("beginner safety brakes by obstacle edge and stopping distance", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.boat.x = 0;
  state.boat.y = 0;
  state.boat.heading = 0;
  state.boat.speed = 12;
  setControl(state, "forward", true);
  const events = step(state, 0.05);
  setControl(state, "forward", false);

  assert.ok(events.some(event => event.type === "safety-brake"));
  assert.match(state.message, /до края препятствия/i);
  assert.ok(state.boat.speed < 12);
});

test("complete stable mission works with ordinary controls and no collision", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const allEvents = [];

  command(state, "sonar");
  let result = driveTo(state, state.world.survivors[0], 6.5);
  allEvents.push(...result.events);
  assert.equal(result.ok, true);
  allEvents.push(...rescue(state));
  assert.equal(state.world.survivors[0].rescued, true);

  state.sonar.cooldown = 0;
  command(state, "sonar");
  for (const target of [{x: 25, y: 100}, state.world.survivors[1]]) {
    result = driveTo(state, target, target.id ? 6.5 : 5);
    allEvents.push(...result.events);
    assert.equal(result.ok, true, `failed route to ${JSON.stringify(target)}`);
  }
  allEvents.push(...rescue(state));
  assert.equal(state.world.survivors[1].rescued, true);

  state.sonar.cooldown = 0;
  command(state, "sonar");
  for (const target of [{x: 25, y: 100}, {x: 28, y: 55}, {x: 20, y: 22}, state.world.harbor]) {
    result = driveTo(state, target, target.id === "harbor" ? 8 : 5);
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

test("a simultaneously flooded and broken hull keeps the emergency repair window", () => {
  const state = createGame({mode: "coop", role: "crew", timed: false});
  startGame(state);
  enterFloodEmergency(state, {hull: 0, leak: 4});

  const repair = command(state, "hull-repair", "crew");
  assert.equal(repair.ok, true);
  assert.equal(setControl(state, "pump", true, "crew"), true);
  const events = run(state, 18);

  assert.equal(state.lost, false);
  assert.equal(state.phase, "playing");
  assert.ok(state.boat.hull > 0);
  assert.equal(getView(state).damageControl.floodEmergency, false);
  assert.ok(events.some(event => event.type === "flood-emergency-recovered"));
});

test("engine repair waits until flooding is controlled and then starts the boat", () => {
  const state = createGame({mode: "coop", role: "crew", timed: false});
  startGame(state);
  enterFloodEmergency(state);

  const premature = command(state, "repair", "crew");
  assert.equal(premature.ok, false);
  assert.equal(premature.reason, "flood-first");

  command(state, "hull-repair", "crew");
  setControl(state, "pump", true, "crew");
  run(state, 18);
  setControl(state, "pump", false, "crew");
  assert.equal(getView(state).damageControl.floodEmergency, false);
  assert.equal(state.boat.engineStalled, true);

  for (let attempt = 0; attempt < 4; attempt += 1) command(state, "repair", "crew");
  assert.equal(state.boat.engineStalled, false);

  setControl(state, "forward", true, "captain");
  run(state, 1.5);
  setControl(state, "forward", false, "captain");
  assert.ok(state.boat.speed > CONFIG.motionStartSpeed);
});

test("flooding progressively closes a real low-pass filter", () => {
  assert.ok(floodMuffleCutoff(0) >= 14_000);
  assert.ok(floodMuffleCutoff(50) < floodMuffleCutoff(20));
  assert.ok(floodMuffleCutoff(80) < floodMuffleCutoff(50));
  assert.ok(floodMuffleCutoff(100) <= 650);
});

test("audio graph inserts the flood filter after the compressor", async () => {
  const connections = [];
  const frequencyCalls = [];
  const filter = {
    type: "",
    Q: {value: 0},
    frequency: {
      value: 0,
      setTargetAtTime(value, time, constant) { frequencyCalls.push({value, time, constant}); },
    },
    connect(target) { connections.push(["filter", target]); return target; },
  };
  const engine = new AudioEngine();
  engine.ctx = {
    currentTime: 4,
    destination: {id: "destination"},
    resume: async () => {},
    createBiquadFilter: () => filter,
  };
  engine.compressor = {
    disconnect() { connections.push(["disconnect"]); },
    connect(target) { connections.push(["compressor", target]); return target; },
  };
  engine.master = {};

  await engine.init();
  engine.updateFloodMuffle(100, true);

  assert.equal(engine.floodFilter, filter);
  assert.equal(filter.type, "lowpass");
  assert.ok(connections.some(([from, target]) => from === "compressor" && target === filter));
  assert.ok(frequencyCalls.at(-1).value <= 650);
});

test("free mode exposes a real no-time-limit view", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const view = getView(state);
  assert.equal(view.timed, false);
  assert.equal(view.remaining, null);
});

test("release ships substantial local water recordings instead of sub-second remote grains", async () => {
  const ambience = await stat(new URL("../public/assets/audio/river-ambience.ogg", import.meta.url));
  const wake = await stat(new URL("../public/assets/audio/boat-wake.ogg", import.meta.url));
  const bilge = await stat(new URL("../public/assets/audio/bilge-water.ogg", import.meta.url));
  assert.ok(ambience.size > 1_000_000);
  assert.ok(wake.size > 100_000);
  assert.ok(bilge.size > 100_000);
});
