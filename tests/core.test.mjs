import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, getView, CONFIG} from "../src/game-core.js";

function run(state, seconds, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) step(state, dt);
}

test("solo assistant pumps a dangerous leak", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  state.boat.water = 50; state.boat.leak = 1;
  const before = state.boat.water;
  run(state, 2);
  assert.equal(state.boat.pumpActive, true);
  assert.ok(state.boat.water < before);
});

test("coop enforces captain and crew responsibilities", () => {
  const state = createGame({mode: "coop"}); startGame(state);
  assert.equal(setControl(state, "left", true, "crew"), false);
  assert.equal(setControl(state, "left", true, "captain"), true);
  assert.equal(command(state, "sonar", "captain").reason, "crew-only");
  assert.equal(command(state, "sonar", "crew").ok, true);
});

test("sonar has cooldown and gives directional target", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  const result = command(state, "sonar");
  assert.equal(result.ok, true);
  assert.ok(state.sonar.lastResult);
  assert.equal(command(state, "sonar").reason, "cooldown");
  run(state, CONFIG.sonarCooldown + 0.1);
  assert.equal(command(state, "sonar").ok, true);
});

test("high load eventually stalls the engine", () => {
  const state = createGame({mode: "coop"}); startGame(state);
  setControl(state, "forward", true, "captain");
  run(state, 150);
  assert.equal(state.boat.engineStalled, true);
});

test("collision creates damage and flooding but has contact cooldown", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  const reef = state.world.hazards[0];
  state.boat.x = reef.x; state.boat.y = reef.y; state.boat.speed = 12;
  step(state, 0.05);
  const hull = state.boat.hull;
  assert.ok(hull < 100);
  step(state, 0.05);
  assert.equal(state.boat.hull, hull);
  assert.ok(state.boat.leak > 0);
});

test("rescue requires slow sustained action", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  const survivor = state.world.survivors[0];
  state.boat.x = survivor.x; state.boat.y = survivor.y; state.boat.speed = 7;
  setControl(state, "rescue", true);
  run(state, 1);
  assert.equal(state.rescued, 0);
  state.boat.speed = 0;
  run(state, 3.2);
  assert.equal(state.rescued, 1);
});

test("complete mission can be won with both survivors and safe docking", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  state.world.survivors.forEach(s => { s.rescued = true; });
  state.rescued = 2;
  state.boat.x = state.world.harbor.x;
  state.boat.y = state.world.harbor.y;
  state.boat.speed = 2;
  step(state, 0.05);
  const view = getView(state);
  assert.equal(view.won, true);
  assert.equal(view.ending, "harbor");
});

test("danger thresholds emit one-shot warning sounds without frame spam", () => {
  const state = createGame({mode: "solo"}); startGame(state);
  state.boat.water = 46;
  const first = step(state, 0.05);
  assert.ok(first.some(event => event.type === "warning" && event.key === "water-high"));
  const second = step(state, 0.05);
  assert.equal(second.some(event => event.type === "warning" && event.key === "water-high"), false);
});

test("invalid role command returns audible denial", () => {
  const state = createGame({mode: "coop"}); startGame(state);
  const result = command(state, "sonar", "captain");
  assert.equal(result.ok, false);
  assert.ok(result.events.some(event => event.type === "ui-deny"));
});
