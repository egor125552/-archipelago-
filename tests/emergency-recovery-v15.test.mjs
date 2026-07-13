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
} from "../public/src/game-core-v12.js";

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
  }
  return events;
}

function floodedCrewState(leak) {
  const state = createGame({
    mode: "coop",
    role: "crew",
    timed: false,
    progression: {
      level: 3,
      boatId: "kasatka",
      upgrades: {"high-flow-pump": true},
    },
  });
  startGame(state);
  state.boat.hull = 4;
  state.boat.water = 99.8;
  state.boat.leak = leak;
  step(state, 0.05);
  assert.equal(getView(state).damageControl.floodEmergency, true);
  return state;
}

function installPatch(state) {
  const result = command(state, "hull-repair", "crew");
  assert.equal(result.ok, true);
  return run(state, CONFIG.hullRepairDuration + 0.15);
}

test("the reported 48-percent hull scenario recovers while the upgraded pump runs", () => {
  const state = floodedCrewState(12.5);
  assert.equal(setControl(state, "pump", true, "crew"), true);
  const events = [...installPatch(state), ...installPatch(state), ...run(state, 30)];

  assert.equal(Math.round(state.boat.hull), 48);
  assert.equal(state.phase, "playing");
  assert.equal(state.lost, false);
  assert.equal(getView(state).damageControl.floodEmergency, false);
  assert.ok(events.some(event => event.type === "flood-emergency-recovered"));
  assert.equal(events.some(event => event.type === "flood-emergency-failed"), false);
});

test("the worst leak remains recoverable with all three plates before the deadline", () => {
  const state = floodedCrewState(16);
  setControl(state, "pump", true, "crew");
  const events = [
    ...installPatch(state),
    ...installPatch(state),
    ...installPatch(state),
    ...run(state, CONFIG.floodEmergencySeconds),
  ];

  assert.equal(state.phase, "playing");
  assert.equal(getView(state).damageControl.floodEmergency, false);
  assert.ok(events.some(event => event.type === "flood-emergency-recovered"));
});

test("the solo helper cannot falsely repair a submerged engine", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  state.boat.hull = 0;
  state.boat.water = 50;
  state.boat.leak = 8;
  step(state, 0.05);
  const events = run(state, 10);

  assert.equal(getView(state).damageControl.floodEmergency, true);
  assert.equal(state.boat.engineStalled, true);
  assert.equal(state.boat.repairProgress, 0);
  assert.equal(events.some(event => event.type === "repair-complete"), false);
});

test("emergency UI exposes every threshold and audio repeats the alarm", async () => {
  const [gameplay, audio, html] = await Promise.all([
    readFile(new URL("../public/src/gameplay-v9.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v9.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(gameplay, /recoveryWaterTarget/);
  assert.match(gameplay, /не является отдельным условием выхода/);
  assert.match(gameplay, /recoveryHullTarget/);
  assert.match(audio, /updateFloodAlarm/);
  assert.match(audio, /nextFloodAlarmAt/);
  assert.match(html, /остаётся 45 секунд/);
});
