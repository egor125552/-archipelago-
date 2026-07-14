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
} from "../public/src/game-core-v17.js";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;

const allUpgrades = Object.freeze({
  "coast-brake": true,
  "mini-armor": true,
  "high-flow-pump": true,
  "ram-keel": true,
  "debris-tools": true,
});

function grom() {
  const state = createGame({mode: "solo", progression: {level: 6, boatId: "grom", upgrades: allUpgrades}});
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

test("Grom keeps every purchased upgrade, thirty patches and the faster tune across saves", () => {
  const state = grom();
  const view = getView(state);
  assert.deepEqual(view.progression.upgrades, {
    coastBrake: true,
    miniArmor: true,
    highFlowPump: true,
    ramKeel: true,
    debrisTools: true,
  });
  assert.equal(state.boat.repairPatches, 30);
  assert.equal(view.boat.repairPatchCapacity, 30);
  assert.ok(state.boat.maxSpeedMultiplier >= 1.82);
  assert.ok(state.boat.accelerationMultiplier >= 1.42);
  assert.ok(state.boat.turnRateMultiplier >= 1.16);
  assert.equal(state.boat.armor, 54);

  state.boat.repairPatches = 27;
  const restored = deserialize(serialize(state));
  assert.equal(restored.boat.repairPatches, 27, "loading must not refill already used plates");
  assert.equal(restored.boat.repairPatchCapacity, 30);
  assert.deepEqual(getView(restored).progression.upgrades, view.progression.upgrades);
});

test("an early rope keeps the beacon active, brakes Grom and completes rescue at every supported frame interval", () => {
  for (const dt of [0.016, 0.05, 0.12, 0.25]) {
    const state = grom();
    const target = state.world.survivors[0];
    state.sonar.cooldown = 0;
    assert.equal(command(state, "sonar").ok, true);
    state.boat.x = target.x;
    state.boat.y = target.y - 25;
    state.boat.heading = 9;
    state.boat.speed = 31;
    state.boat.throttle = 1;
    state.controls.forward = true;
    assert.equal(setControl(state, "rescue", true), true);

    const before = getView(state);
    assert.equal(before.navigation.rescueMode, false);
    assert.equal(before.navigation.beaconSuppressed, false);
    assert.equal(state.controls.rescue, true);

    const events = run(state, 9, dt);
    assert.ok(events.some(event => event.type === "rescue-complete"), `dt ${dt}`);
    assert.equal(target.rescued, true, `dt ${dt}`);
    assert.ok(distance(state.boat, target) <= CONFIG.rescueRadius + 0.5, `dt ${dt}`);
    assert.ok(Math.abs(state.boat.speed) <= 0.01, `dt ${dt}`);
    assert.equal(events.some(event => event.type === "collision"), false, `dt ${dt}`);
    assert.deepEqual(getView(state).progression.upgrades, {
      coastBrake: true,
      miniArmor: true,
      highFlowPump: true,
      ramKeel: true,
      debrisTools: true,
    });
  }
});

test("a rope prepared at long range no longer hides or recenters a wrong-way beacon", () => {
  const state = grom();
  const target = state.world.survivors[0];
  command(state, "sonar");
  state.boat.x = target.x - 45;
  state.boat.y = target.y - 45;
  state.boat.heading = 0;
  setControl(state, "rescue", true);
  step(state, 0.05);
  const view = getView(state);
  assert.equal(view.navigation.rescueMode, false);
  assert.equal(view.navigation.beaconSuppressed, false);
  assert.ok(Math.abs(view.navigation.beaconPan) > 0.1);
  assert.equal(state.controls.rescue, true);
});

test("the complete level-six Grom operation remains winnable with ordinary controls", () => {
  const state = grom();
  const events = [];
  for (const target of [...state.world.survivors, state.world.harbor]) {
    state.sonar.cooldown = 0;
    assert.equal(command(state, "sonar").ok, true);
    state.boat.heading = wrap(bearing(state.boat, target) + 6);
    setControl(state, "forward", true);
    for (let elapsed = 0; elapsed < 150 && state.phase === "playing"; elapsed += 0.071) {
      if (target.id !== "harbor" && !target.rescued && distance(state.boat, target) < 27 && !state.controls.rescue) {
        setControl(state, "rescue", true);
      }
      const view = getView(state);
      if (view.hunter.active && view.hunter.distance < 42 && view.hunter.decoyCharges && !view.hunter.decoyActive) {
        command(state, "hunter-decoy");
      }
      events.push(...step(state, 0.071));
      if (target.id === "harbor" ? state.won : target.rescued) break;
    }
    if (target.id !== "harbor") setControl(state, "rescue", false);
  }
  assert.equal(state.won, true);
  assert.equal(state.rescued, 2);
  assert.ok(state.boat.hull > 0);
  assert.equal(events.some(event => event.type === "collision"), false);
});

test("the hunter mostly pursues but also patrols, circles, stops and retreats", () => {
  const state = grom();
  state.hunter.ramCooldown = 999;
  const samples = [];
  for (let elapsed = 0; elapsed < 80; elapsed += 0.1) {
    step(state, 0.1);
    if (elapsed >= CONFIG.hunterSpawnDelay) samples.push(state.hunter.mode);
  }
  const modes = new Set(samples);
  for (const mode of ["pursuit", "circle", "patrol", "stop", "retreat"]) assert.ok(modes.has(mode), mode);
  const pursuit = samples.filter(mode => mode === "pursuit").length;
  assert.ok(pursuit > samples.length / 2, `${pursuit}/${samples.length}`);
});

test("the pursuer loses hull and speed when it rams the player", () => {
  const state = createGame({mode: "solo", progression: {level: 6, boatId: "strizh", upgrades: {}}});
  startGame(state);
  state.training.safetyEnabled = false;
  state.totalElapsed = CONFIG.hunterSpawnDelay + 0.1;
  state.boat.x = 0;
  state.boat.y = 0;
  state.boat.heading = 0;
  state.boat.speed = 0;
  Object.assign(state.hunter, {x: 0, y: -8, heading: 0, speed: 24, ramCooldown: 0, recoverUntil: 0});
  const events = step(state, 0.01);
  const ram = events.find(event => event.type === "hunter-ram");
  assert.ok(ram);
  assert.ok(state.boat.hull < 100);
  assert.ok(state.hunter.hull < 100);
  assert.ok(state.hunter.speed < 0);
  assert.equal(state.hunter.mode, "retreat");
  assert.ok(getView(state).hunter.maxSpeed < CONFIG.hunterMaxSpeed);
});

test("a fast Grom can ram and eventually disable the pursuer", () => {
  const state = grom();
  state.totalElapsed = CONFIG.hunterSpawnDelay + 0.1;
  const hits = [];
  for (let attempt = 0; attempt < 4 && !state.hunter.destroyed; attempt += 1) {
    state.boat.x = 0;
    state.boat.y = 0;
    state.boat.heading = 90;
    state.boat.speed = 28;
    state.boat.throttle = 1;
    Object.assign(state.hunter, {
      x: 8,
      y: 0,
      heading: 270,
      speed: 0,
      ramCooldown: 0,
      recoverUntil: 0,
      repositionUntil: 0,
    });
    hits.push(...step(state, 0.01));
  }
  assert.ok(hits.filter(event => event.type === "hunter-hit").length >= 2);
  assert.ok(hits.some(event => event.type === "hunter-destroyed"));
  assert.equal(state.hunter.destroyed, true);
  assert.equal(state.hunter.hull, 0);
  assert.equal(getView(state).hunter.active, false);
  assert.equal(getView(state).hunter.destroyed, true);
  assert.ok(state.boat.hull > 0);
});

test("VoiceOver turn pulses restore the same control focus and release assets use cache v23", async () => {
  const [gameplay, html, audio] = await Promise.all([
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v12.js", import.meta.url), "utf8"),
  ]);
  assert.match(gameplay, /function keepReaderFocus\(button\)/);
  assert.match(gameplay, /requestAnimationFrame\(restore\)/);
  assert.ok((gameplay.match(/keepReaderFocus\(button\)/g) || []).length >= 6);
  assert.match(html, /game-core-v18\.js\?v=23\.0/);
  assert.match(html, /audio-engine-v13\.js\?v=23\.0/);
  assert.match(audio, /hunter-destroyed/);
});
