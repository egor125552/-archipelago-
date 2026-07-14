import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  command,
  createGame,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v18.js";

function started() {
  const state = createGame({mode: "solo", timed: false});
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

test("a long-range rope tells the player to keep driving until auto-approach range", () => {
  const state = started();
  assert.equal(command(state, "sonar").ok, true);
  const before = {x: state.boat.x, y: state.boat.y};

  assert.equal(setControl(state, "rescue", true), true);
  assert.match(state.message, /Следуй маяку/);
  assert.match(state.message, /с 30 метров/);

  run(state, 2);
  assert.ok(Math.hypot(state.boat.x - before.x, state.boat.y - before.y) < 0.01);
  assert.equal(state.world.survivors[0].rescued, false);
});

test("auto-approach suppresses the obsolete rope-too-far warning and completes rescue", () => {
  const state = started();
  const target = state.world.survivors[0];
  state.boat.x = target.x;
  state.boat.y = target.y - 18;
  state.sonar.cooldown = 0;
  assert.equal(command(state, "sonar").ok, true);

  assert.equal(setControl(state, "rescue", true), true);
  assert.match(state.message, /Автоподход включён/);
  const firstEvents = step(state, 0.05);
  assert.equal(firstEvents.some(event => event.type === "rope-far"), false);
  assert.doesNotMatch(state.message, /Трос не достаёт/);

  const events = run(state, 8);
  assert.ok(events.some(event => event.type === "rescue-complete"));
  assert.equal(target.rescued, true);
});

test("negative speed is exposed as reverse motion in status and location", () => {
  const state = started();
  state.boat.speed = -2.3;
  assert.equal(getView(state).boat.motionState, "идёт задним ходом");
  assert.equal(command(state, "where").ok, true);
  assert.match(state.message, /Лодка идёт задним ходом/);

  state.boat.speed = -1.2;
  assert.equal(getView(state).boat.motionState, "дрейфует назад");
});

test("the near-standstill steering warning is replaced once the boat gains speed", () => {
  const state = started();
  state.totalElapsed = 2;
  state.controls.right = true;
  step(state, 0.05);
  assert.match(state.message, /лодка почти стоит/i);

  state.boat.speed = 2;
  step(state, 0.05);
  assert.doesNotMatch(state.message, /лодка почти стоит/i);
  assert.match(state.message, /Лодка набрала ход/);
});

test("release UI explains loading, route state, one-click braking and cache generation 23", async () => {
  const [app, gameplay, html] = await Promise.all([
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(app, /Запускаю операцию: подготавливаю звук и игровую сцену/);
  assert.match(app, /readerAnnouncementClearTimer/);
  assert.match(app, /обычный; риск закрыт до уровня 2/);
  assert.match(gameplay, /initialSpeed < -0\.25 \? "forward" : control/);
  assert.match(gameplay, /Math\.abs\(speed\) <= 0\.25/);
  assert.match(gameplay, /Задний ход:/);
  assert.match(html, /Режим маршрута/);
  assert.match(html, /game-core-v18\.js\?v=23\.0/);
  assert.match(html, /audio-engine-v13\.js\?v=23\.0/);
});
