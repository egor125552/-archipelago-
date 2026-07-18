import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CONFIG,
  command,
  createGame,
  deserialize,
  getView,
  serialize,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v18.js";

function started({level = 2, boatId = "strizh", mode = "solo", upgrades = {}} = {}) {
  const state = createGame({mode, progression: {level, boatId, upgrades}});
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

function hitEastShore(state, speed) {
  state.boat.x = state.world.bounds.maxX - 0.1;
  state.boat.y = Math.min(80, state.world.bounds.maxY - 20);
  state.boat.heading = 90;
  state.boat.speed = speed;
  state.boat.throttle = 1;
  state.controls.forward = true;
  const events = step(state, 0.1);
  return events.find(event => event.type === "collision" && event.shore);
}

test("a fast shoreline impact causes severe speed-scaled damage, a leak and a hard rebound", () => {
  const slow = started();
  const slowHit = hitEastShore(slow, 4);
  const fast = started();
  const fastHit = hitEastShore(fast, 18);
  assert.ok(slowHit);
  assert.ok(fastHit);
  assert.ok(fastHit.damage > slowHit.damage * 3, `${slowHit.damage} -> ${fastHit.damage}`);
  assert.ok(fastHit.damage > 60, fastHit.damage);
  assert.ok(fast.boat.leak > slow.boat.leak);
  assert.ok(fast.boat.speed < 0);
  assert.equal(fast.controls.forward, false);
  assert.ok(fast.boat.x <= fast.world.bounds.maxX - CONFIG.shoreInset + 0.01);
  assert.match(fast.message, /Сильный удар о берег/);
});

test("a gentle shoreline touch stops the boat without invented damage or a reverse launch", () => {
  const state = started();
  state.boat.x = state.world.bounds.maxX + 0.05;
  state.boat.y = Math.min(80, state.world.bounds.maxY - 20);
  state.boat.heading = 90;
  state.boat.speed = 0.5;
  const hull = state.boat.hull;
  const events = step(state, 0.01);
  const touch = events.find(event => event.type === "collision" && event.shore);
  assert.ok(touch);
  assert.equal(touch.scrape, true);
  assert.equal(touch.damage, 0);
  assert.equal(state.boat.hull, hull);
  assert.equal(state.boat.speed, 0);
  assert.match(state.message, /мягко коснулась берега/);
});

test("Grom armor softens but does not erase a violent shore crash", () => {
  const state = started({
    level: 6,
    boatId: "grom",
    upgrades: {"mini-armor": true},
  });
  const hit = hitEastShore(state, 18);
  assert.ok(hit.absorbed > 20);
  assert.ok(hit.damage > 20);
  assert.ok(state.boat.hull < 80);
  assert.ok(state.boat.armor < state.boat.armorMax);
});

test("shore cooldown prevents damage and sound spam while nearby wrecks remain untouched", () => {
  const state = started({level: 6, boatId: "grom"});
  const durability = new Map(state.world.hazards.map(hazard => [hazard.id, hazard.durability]));
  const first = hitEastShore(state, 14);
  assert.ok(first);
  const hull = state.boat.hull;
  state.boat.x = state.world.bounds.maxX - 0.1;
  state.boat.heading = 90;
  state.boat.speed = 14;
  state.controls.forward = true;
  const repeated = step(state, 0.05);
  assert.equal(repeated.some(event => event.type === "collision" && event.shore), false);
  assert.equal(state.boat.hull, hull);
  for (const hazard of state.world.hazards) assert.equal(hazard.durability, durability.get(hazard.id), hazard.id);
});

test("empty fuel offers one stopped emergency canister instead of an immediate soft-lock", () => {
  const state = started();
  state.boat.x = 40;
  state.boat.y = 50;
  state.boat.fuel = 0;
  state.boat.speed = 0;
  state.boat.engineStalled = true;
  const empty = step(state, 0.05);
  assert.equal(state.phase, "playing");
  assert.ok(empty.some(event => event.type === "fuel-empty-ready"));
  assert.equal(getView(state).refuel.canisters, 1);
  assert.equal(getView(state).quickLabel, "Использовать аварийную канистру");

  const start = command(state, "quick");
  assert.equal(start.ok, true);
  assert.equal(state.refuel.active, true);
  assert.equal(setControl(state, "forward", true), false);
  const events = run(state, CONFIG.emergencyFuelDuration + 0.2);
  assert.ok(events.some(event => event.type === "fuel-refuel-complete"));
  assert.ok(state.boat.fuel > 29.9 && state.boat.fuel <= 30);
  assert.equal(state.refuel.canisters, 0);
  assert.equal(state.boat.engineStalled, false);
});

test("after the canister is spent, a second empty tank far from harbor still ends the operation", () => {
  const state = started();
  state.boat.x = 40;
  state.boat.y = 50;
  state.refuel.canisters = 0;
  state.boat.fuel = 0;
  state.boat.speed = 0;
  state.boat.engineStalled = true;
  const events = step(state, 0.05);
  assert.equal(state.phase, "finished");
  assert.equal(state.ending, "fuel");
  assert.ok(events.some(event => event.type === "lose" && event.reason === "fuel"));
});

test("the harbor fills the tank completely without consuming the emergency canister", () => {
  const state = started();
  state.boat.fuel = 7;
  state.boat.speed = 0;
  const start = command(state, "refuel");
  assert.equal(start.ok, true);
  assert.equal(state.refuel.source, "harbor");
  assert.equal(state.boat.engineStalled, true, "engine is shut down while refueling");
  run(state, CONFIG.harborFuelDuration + 0.2);
  assert.ok(state.boat.fuel > 99.9 && state.boat.fuel <= 100);
  assert.equal(state.refuel.canisters, 1);
  assert.equal(state.boat.engineStalled, false);
});

test("refueling requires a stopped boat and belongs to the systems operator in coop", () => {
  const moving = started();
  moving.boat.fuel = 40;
  moving.boat.speed = 3;
  assert.equal(command(moving, "refuel").reason, "too-fast");

  const coop = started({mode: "coop"});
  coop.boat.fuel = 40;
  assert.equal(command(coop, "refuel", "captain").reason, "crew-only");
  assert.equal(command(coop, "refuel", "crew").ok, true);
});

test("refueling cannot overlap the manual pump, service or debris extraction", () => {
  const state = started({level: 5});
  state.boat.fuel = 40;
  assert.equal(setControl(state, "pump", true), true);
  assert.equal(command(state, "refuel").reason, "busy");
  assert.equal(setControl(state, "pump", false), true);

  assert.equal(command(state, "refuel").ok, true);
  assert.equal(setControl(state, "pump", true), false);
  assert.equal(command(state, "repair").reason, "refuel-busy");
  assert.equal(command(state, "debris-remove").reason, "refuel-busy");
  assert.equal(state.engineService.active, false);
  assert.equal(state.debris.removing, false);
  assert.equal(command(state, "refuel").ok, true, "the same control still cancels refueling");
  assert.equal(state.refuel.active, false);
});

test("the floating brake overrides coast braking and cannot be spammed", () => {
  const state = started({upgrades: {"coast-brake": true}});
  state.boat.speed = 9;
  state.controls.forward = true;
  assert.equal(setControl(state, "forward", false), true);
  assert.equal(state.progression.coastBrakeActive, true);

  const stop = command(state, "anchor");
  assert.equal(stop.ok, true);
  assert.ok(Math.abs(state.boat.speed) <= 0.12);
  assert.equal(state.progression.coastBrakeActive, false);
  const stoppedSpeed = Math.abs(state.boat.speed);
  step(state, 0.05);
  assert.ok(Math.abs(state.boat.speed) <= stoppedSpeed, `${stoppedSpeed} -> ${state.boat.speed}`);

  const restored = deserialize(serialize(state));
  assert.equal(command(restored, "anchor").reason, "brake-cooldown");
  assert.equal(getView(restored).floatingBrake.ready, false);
  run(restored, CONFIG.floatingBrakeCooldown + 0.1);
  assert.equal(getView(restored).floatingBrake.ready, true);
  const stopped = command(restored, "anchor");
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "already-stopped");
  assert.equal(getView(restored).floatingBrake.ready, true);
  restored.boat.speed = 3;
  assert.equal(command(restored, "anchor").ok, true);
});

test("used canisters and active refueling survive serialization without being refilled", () => {
  const state = started();
  state.boat.x = 40;
  state.boat.y = 50;
  state.boat.fuel = 10;
  assert.equal(command(state, "refuel").ok, true);
  run(state, 1.2);
  const restored = deserialize(serialize(state));
  assert.equal(restored.refuel.active, true);
  assert.ok(restored.refuel.progress > 20);
  run(restored, 4);
  assert.equal(restored.refuel.canisters, 0);
  assert.ok(restored.boat.fuel > 39.9 && restored.boat.fuel <= 40);
  const again = deserialize(serialize(restored));
  assert.equal(again.refuel.canisters, 0);
});

test("release UI exposes refueling, heavy shore audio and cache generation 27", async () => {
  const [html, app, gameplay, audio] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v13.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="refuelButton"/);
  assert.match(html, /game-core-v18\.js\?v=27\.0/);
  assert.match(html, /audio-engine-v13\.js\?v=27\.0/);
  assert.match(app, /sendCommand\("refuel"\)/);
  assert.match(gameplay, /Используй аварийную канистру/);
  assert.match(audio, /event\.shore/);
  assert.match(audio, /event\.scrape/);
  assert.match(audio, /event\.hardImpact/);
  assert.match(audio, /fuel-refuel-complete/);
});
