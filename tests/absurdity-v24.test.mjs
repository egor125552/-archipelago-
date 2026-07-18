import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CONFIG,
  command,
  createGame,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v18.js";

function started({level = 2, upgrades = {}} = {}) {
  const state = createGame({mode: "solo", progression: {level, boatId: "strizh", upgrades}});
  startGame(state);
  state.training.safetyEnabled = false;
  return state;
}

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
  }
  return events;
}

test("releasing forward removes engine thrust immediately while preserving physical coast", () => {
  const state = started();
  assert.equal(setControl(state, "forward", true), true);
  run(state, 1.3);
  const before = state.boat.speed;
  assert.ok(before > 1);
  assert.ok(state.boat.throttle > 0);
  assert.equal(setControl(state, "forward", false), true);
  assert.equal(state.boat.throttle, 0);
  step(state, 0.25);
  assert.ok(state.boat.speed <= before, `${before} -> ${state.boat.speed}`);
  assert.ok(state.boat.speed > 0, "the hull should still coast");
});

test("releasing reverse removes stale reverse thrust", () => {
  const state = started();
  assert.equal(setControl(state, "reverse", true), true);
  run(state, 0.8);
  assert.ok(state.boat.throttle < 0);
  assert.equal(setControl(state, "reverse", false), true);
  assert.equal(state.boat.throttle, 0);
});

test("the navigation helper does not secretly lock a target before sonar", () => {
  const state = started();
  assert.equal(state.navigation.lockedTargetId, null);
  const events = run(state, 3);
  assert.equal(state.navigation.lockedTargetId, null);
  assert.equal(state.sonar.pings, 0);
  assert.equal(events.some(event => event.type === "navigation-cue"), false);
  assert.equal(getView(state).navigation.targetDistance, null);
});

test("a stationary boat cannot waste the floating brake cooldown", () => {
  const state = started();
  const before = state.floatingBrake.readyAt;
  const result = command(state, "anchor");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "already-stopped");
  assert.equal(state.floatingBrake.readyAt, before);
  assert.equal(getView(state).floatingBrake.ready, true);
  assert.match(state.message, /уже стоит/);
});

test("the floating brake still works while moving and repeated use reports cooldown", () => {
  const state = started();
  state.boat.speed = 9;
  const first = command(state, "anchor");
  assert.equal(first.ok, true);
  assert.ok(Math.abs(state.boat.speed) <= 0.12);
  const second = command(state, "anchor");
  assert.equal(second.reason, "brake-cooldown");
});

test("rescue rope is rejected after everyone is already aboard", () => {
  const state = started();
  for (const survivor of state.world.survivors) survivor.rescued = true;
  state.rescued = state.world.survivors.length;
  assert.equal(setControl(state, "rescue", true), false);
  assert.equal(state.controls.rescue, false);
  assert.match(state.message, /Все люди уже на борту/);
});

test("an intact hull does not enter a fake repair state", () => {
  const state = started();
  state.boat.hull = 100;
  state.boat.leak = 0;
  assert.equal(setControl(state, "hullRepair", true), false);
  assert.equal(state.controls.hullRepair, false);
  assert.match(state.message, /Корпус цел/);
});

test("the coast brake uses a logical name and release assets use cache generation 27", async () => {
  const [html, app, progression] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/progression.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /game-core-v18\.js\?v=27\.0/);
  assert.match(html, /app\.js\?v=27\.0/);
  assert.match(app, /progression\.js\?v=27\.0/);
  assert.match(progression, /Автотормоз наката/);
  assert.doesNotMatch(progression, /Береговой автотормоз/);

  const state = started({upgrades: {"coast-brake": true}});
  state.boat.speed = 4;
  const events = run(state, CONFIG.coastBrakeSeconds + 0.2);
  assert.ok(events.some(event => event.type === "auto-stop"));
  assert.match(state.message, /Автотормоз наката/);
});
