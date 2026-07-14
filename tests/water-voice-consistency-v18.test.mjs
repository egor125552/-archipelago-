import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import * as legacy from "../public/src/game-core-v14.js";
import {
  CONFIG,
  command,
  createGame,
  deserialize,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v15.js";

function started(options = {}) {
  const state = createGame({mode: "solo", timed: false, ...options});
  startGame(state);
  return state;
}

function run(state, seconds, dt = 0.05, tick = step) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...tick(state, Math.min(dt, seconds - elapsed)));
  }
  return events;
}

test("a water-stalled engine restarts after pumping without fake mechanical repair", () => {
  const state = started();
  state.boat.water = CONFIG.engineFloodStallWater + 0.1;
  state.boat.leak = 0;
  setControl(state, "reverse", true);
  const flooded = step(state, 0.05);
  assert.ok(flooded.some(event => event.type === "engine-flooded"));
  assert.equal(state.waterEngine.locked, true);
  assert.equal(state.boat.engineStalled, true);
  assert.equal(state.controls.reverse, false);

  setControl(state, "pump", true);
  const events = run(state, 8);
  assert.ok(state.boat.water <= CONFIG.waterEngineRestartWater);
  assert.ok(events.some(event => event.type === "engine-water-restart"));
  assert.equal(state.boat.engineStalled, false);
  assert.equal(state.engineService.progress, 0);
});

test("zero water and a safe hull allow immediate restart and movement", () => {
  const state = started();
  state.boat.hull = 0;
  state.boat.water = 100;
  state.boat.leak = 0;
  step(state, 0.05);
  assert.equal(state.damageControl.floodEmergency, true);

  state.boat.hull = 10;
  state.boat.water = 0;
  const recovered = step(state, 0.05);
  assert.ok(recovered.some(event => event.type === "flood-emergency-recovered"));
  assert.equal(getView(state).waterEngine.canRestart, true);

  assert.equal(setControl(state, "forward", true), true);
  assert.equal(state.waterEngine.locked, false);
  assert.equal(state.boat.engineStalled, false);
  run(state, 0.6);
  assert.ok(state.boat.speed > 1);
});

test("zero water does not hide a genuinely broken hull", () => {
  const state = started();
  state.boat.hull = 0;
  state.boat.water = 100;
  state.boat.leak = 0;
  step(state, 0.05);
  state.boat.water = 0;
  step(state, 0.05);

  assert.equal(state.damageControl.floodEmergency, true);
  assert.equal(setControl(state, "forward", true), false);
  assert.match(state.message, /стабилизируй/i);

  assert.equal(command(state, "hull-repair").ok, true);
  const events = run(state, CONFIG.hullRepairDuration + 0.3);
  assert.ok(events.some(event => event.type === "hull-repair-complete"));
  assert.equal(state.damageControl.floodEmergency, false);
  assert.ok(state.boat.hull >= CONFIG.floodRecoveryHull);
});

test("emergency instructions ask only for the missing action", () => {
  const flooded = started();
  flooded.boat.hull = 100;
  flooded.boat.water = 100;
  flooded.boat.leak = 0;
  step(flooded, 0.05);
  assert.match(flooded.message, /Включи насос/);
  assert.doesNotMatch(flooded.message, /Пластин/);

  const wrecked = started();
  wrecked.boat.hull = 0;
  wrecked.boat.water = 0;
  wrecked.boat.leak = 0;
  step(wrecked, 0.05);
  assert.match(wrecked.message, /Поставь пластину/);
  assert.doesNotMatch(wrecked.message, /насос/i);
});

test("real overheat still requires timed service", () => {
  const state = started();
  state.boat.engineStalled = true;
  state.boat.engineTemp = 104;
  const repair = command(state, "repair");
  assert.equal(repair.ok, true);
  assert.equal(state.engineService.active, true);
  run(state, CONFIG.engineServiceDuration - 0.15);
  assert.equal(state.boat.engineStalled, true);
  const events = run(state, 0.25);
  assert.ok(events.some(event => event.type === "repair-complete"));
  assert.equal(state.boat.engineStalled, false);
});

test("an overheated water-stalled engine exposes its real service action", () => {
  const state = started();
  state.boat.engineStalled = true;
  state.boat.engineTemp = 96;
  state.waterEngine.locked = true;
  state.waterEngine.reason = "water";
  state.boat.water = 0;
  const view = getView(state);
  assert.equal(view.waterEngine.canRestart, false);
  assert.equal(view.waterEngine.canService, true);
  assert.equal(view.canRepair, true);
  assert.equal(command(state, "repair").ok, true);
  assert.equal(state.engineService.active, true);
});

test("a stalled engine cannot create reverse thrust", () => {
  const state = started();
  state.boat.engineStalled = true;
  state.boat.engineTemp = 104;
  assert.equal(setControl(state, "reverse", true), true);
  run(state, 1.5);
  assert.equal(state.boat.throttle, 0);
  assert.equal(state.boat.speed, 0);
});

test("the solo helper keeps pumping while the player rescues", () => {
  const state = started();
  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x;
  state.boat.y = survivor.y;
  state.boat.speed = 0;
  state.boat.water = 60;
  state.boat.leak = 0;
  command(state, "pump-assist-toggle");
  setControl(state, "rescue", true);
  const before = state.boat.water;
  run(state, 1);
  assert.ok(state.boat.water < before - 4);
  assert.ok(survivor.progress > 0.8);
  assert.equal(state.boat.pumpActive, true);
});

test("docking cannot bypass an active flood emergency", () => {
  const state = started();
  state.boat.hull = 0;
  state.boat.water = 100;
  step(state, 0.05);
  state.rescued = 2;
  state.world.survivors.forEach(survivor => { survivor.rescued = true; });
  state.boat.x = state.world.harbor.x;
  state.boat.y = state.world.harbor.y;
  state.boat.hull = 10;
  state.boat.water = 50;
  state.boat.speed = 0;
  const score = state.score;
  const events = step(state, 0.05);
  assert.equal(state.damageControl.floodEmergency, true);
  assert.equal(state.won, false);
  assert.equal(state.phase, "playing");
  assert.equal(state.score, score);
  assert.equal(events.some(event => event.type === "win"), false);
});

test("dry legacy water stalls migrate to the new restart state", () => {
  const old = legacy.createGame({mode: "solo", timed: false});
  legacy.startGame(old);
  old.boat.water = legacy.CONFIG.engineFloodStallWater + 0.1;
  old.boat.leak = 0;
  legacy.step(old, 0.05);
  legacy.setControl(old, "pump", true);
  run(old, 8, 0.05, legacy.step);
  assert.equal(old.boat.engineStalled, true);
  assert.equal(old.damageControl.engineFlooded, false);

  const migrated = deserialize(legacy.serialize(old));
  assert.equal(migrated.waterEngine.locked, true);
  assert.equal(setControl(migrated, "forward", true), true);
  assert.equal(migrated.boat.engineStalled, false);
});

test("frequent core speech stays short", () => {
  const state = started({progression: {level: 2, boatId: "strizh", upgrades: {}}});
  const check = () => assert.ok(
    state.message.length <= CONFIG.voiceMessageLimit,
    `${state.message.length}: ${state.message}`,
  );
  check();
  for (const action of ["sonar", "where", "pump-assist-toggle", "risk-route-toggle", "safety-toggle"]) {
    state.sonar.cooldown = 0;
    command(state, action);
    check();
  }
  state.boat.hull = 0;
  state.boat.water = 100;
  for (let index = 0; index < 20; index += 1) {
    step(state, 0.1);
    check();
  }
});

test("release UI exposes water restart and compact VoiceOver text", async () => {
  const [html, app, gameplay, emergency, audio] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v9.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v10.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /game-core-v18\.js\?v=23\.0/);
  assert.match(html, /После стабилизации мотор запускается сам/);
  assert.match(app, /waterEngine\?\.canRestart/);
  assert.match(gameplay, /Запустить мотор/);
  for (const field of ["Скорость", "Курс", "Корпус", "Вода", "Топливо"]) assert.match(gameplay, new RegExp(field));
  assert.match(emergency, /Авария:.*Вода.*Корпус.*Насос/s);
  assert.doesNotMatch(emergency, /не является отдельным условием выхода/);
  assert.match(audio, /engine-water-restart/);
});
