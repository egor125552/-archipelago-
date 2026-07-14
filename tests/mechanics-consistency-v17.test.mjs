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
} from "../public/src/game-core-v14.js";

function advance(state, seconds, dt = 0.1) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) {
    events.push(...step(state, Math.min(dt, seconds - elapsed)));
  }
  return events;
}

function playing(options = {}) {
  const state = createGame({mode: "solo", ...options});
  startGame(state);
  state.timed = false;
  return state;
}

test("solo auto-pump is explicit, defaults off and can be toggled", () => {
  const state = playing();
  state.boat.water = 40;
  state.boat.leak = 1;
  advance(state, 1);
  assert.equal(state.crew.pumpAssistEnabled, false);
  assert.equal(state.boat.pumpActive, false);
  const beforeAssist = state.boat.water;

  const result = command(state, "pump-assist-toggle");
  assert.equal(result.ok, true);
  advance(state, 0.5);
  assert.equal(state.crew.pumpAssistEnabled, true);
  assert.equal(state.boat.pumpActive, true);
  assert.ok(state.boat.water < beforeAssist);
  assert.equal(getView(state).pumpAssist.enabled, true);
});

test("with auto-pump off a leak can fill the boat completely and starts the emergency", () => {
  const state = playing();
  state.boat.leak = 16;
  const events = advance(state, 32);
  assert.equal(state.crew.pumpAssistEnabled, false);
  assert.ok(events.some(event => event.type === "flood-emergency-start"));
  assert.equal(state.damageControl.floodEmergency, true);
  assert.equal(getView(state).boat.water, 100);
});

test("a pump removes water but never repairs the leak", () => {
  const state = playing();
  state.boat.water = 55;
  state.boat.leak = 6.4;
  setControl(state, "pump", true);
  advance(state, 8);
  assert.ok(state.boat.water < 55);
  assert.equal(state.boat.leak, 6.4);
});

test("dry and structurally sound boat exits emergency even with a remaining leak", () => {
  const state = playing();
  state.boat.hull = 0;
  state.boat.water = 100;
  state.boat.leak = 16;
  step(state, 0.1);
  assert.equal(state.damageControl.floodEmergency, true);

  state.boat.hull = 10;
  state.boat.water = 34;
  const events = step(state, 0.1);
  assert.ok(events.some(event => event.type === "flood-emergency-recovered"));
  assert.equal(state.damageControl.floodEmergency, false);
  assert.equal(getView(state).damageControl.recoveryLeakTarget, null);
  assert.equal(getView(state).damageControl.recommendedLeakTarget, CONFIG.floodRecoveryLeak);
});

test("engine service is one timed action and requires a dry stopped boat", () => {
  const wet = playing();
  wet.boat.engineStalled = true;
  wet.boat.water = CONFIG.engineServiceMaxWater + 0.1;
  assert.equal(command(wet, "repair").reason, "water-high");

  const moving = playing();
  moving.boat.engineStalled = true;
  moving.boat.speed = 0.4;
  assert.equal(command(moving, "repair").reason, "too-fast");

  const state = playing();
  state.boat.engineStalled = true;
  assert.equal(command(state, "repair").ok, true);
  assert.equal(command(state, "repair").ok, true);
  assert.equal(state.engineService.progress, 0);
  advance(state, CONFIG.engineServiceDuration - 0.2);
  assert.equal(state.boat.engineStalled, true);
  const events = advance(state, 0.3);
  assert.ok(events.some(event => event.type === "repair-complete"));
  assert.equal(state.boat.engineStalled, false);
});

test("rising water cancels engine service instead of repairing a submerged motor", () => {
  const state = playing();
  state.boat.engineStalled = true;
  state.boat.water = CONFIG.engineServiceMaxWater;
  state.boat.leak = 16;
  command(state, "repair");
  const events = step(state, 0.1);
  assert.ok(events.some(event => event.type === "engine-service-cancel"));
  assert.equal(state.engineService.active, false);
  assert.equal(state.boat.engineStalled, true);
});

test("a stalled engine does not consume fuel or repair itself", () => {
  const state = playing();
  state.boat.engineStalled = true;
  state.boat.fuel = 50;
  advance(state, 20);
  assert.equal(state.boat.fuel, 50);
  assert.equal(state.boat.engineStalled, true);
  assert.equal(state.engineService.progress, 0);
});

test("deep flooding stalls the engine before the boat reaches total loss", () => {
  const state = playing();
  state.boat.water = CONFIG.engineFloodStallWater - 0.01;
  state.boat.leak = 4;
  const events = step(state, 0.1);
  assert.ok(events.some(event => event.type === "engine-flooded"));
  assert.equal(state.boat.engineStalled, true);
  assert.equal(state.damageControl.floodEmergency, false);
  assert.ok(state.boat.water < 100);
});

test("rope progress decays after cancellation and rescue is blocked during flood emergency", () => {
  const state = playing();
  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x;
  state.boat.y = survivor.y;
  state.boat.speed = 0;
  setControl(state, "rescue", true);
  advance(state, 1);
  assert.ok(survivor.progress > 0);
  setControl(state, "rescue", false);
  advance(state, 2);
  assert.equal(survivor.progress, 0);

  state.damageControl.floodEmergency = true;
  assert.equal(setControl(state, "rescue", true), false);
  assert.equal(command(state, "quick").reason, "flood-first");
});

test("a very long free operation never subtracts the completion bonus", () => {
  const state = playing();
  state.score = 1000;
  state.rescued = 2;
  for (const survivor of state.world.survivors) survivor.rescued = true;
  state.boat.x = state.world.harbor.x;
  state.boat.y = state.world.harbor.y;
  state.boat.speed = 0;
  state.totalElapsed = 5000;
  step(state, 0.1);
  assert.equal(state.won, true);
  assert.ok(state.score >= 1000);
});

test("release UI exposes the explicit helper, engine service and new cache generation", async () => {
  const [html, gameplay] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /pumpAssistButton/);
  assert.match(html, /game-core-v18\.js\?v=24\.0/);
  assert.match(html, /доведи воду до 35 процентов или ниже/);
  assert.match(gameplay, /Запустить мотор/);
  assert.match(gameplay, /pump-assist-toggle/);
});
