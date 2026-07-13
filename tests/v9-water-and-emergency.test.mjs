import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, command, step, getView, CONFIG} from "../public/src/game-core-v9.js";

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
  }
  return events;
}

test("an idle boat stays in place in the calm river bay", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  const start = {x: state.boat.x, y: state.boat.y};
  const events = run(state, 20);
  assert.equal(state.boat.speed, 0);
  assert.ok(Math.hypot(state.boat.x - start.x, state.boat.y - start.y) < 0.01);
  assert.equal(getView(state).boat.motionState, "стоит");
  assert.equal(events.some(event => event.type === "motion-start"), false);
});

test("full flooding starts an emergency window instead of instant defeat", () => {
  const state = createGame({mode: "coop", role: "crew", timed: false});
  startGame(state);
  state.boat.water = 99.8;
  state.boat.leak = 16;
  const events = step(state, 0.25);
  const view = getView(state);

  assert.equal(state.phase, "playing");
  assert.equal(state.lost, false);
  assert.equal(view.damageControl.floodEmergency, true);
  assert.equal(view.boat.water, 100);
  assert.ok(view.damageControl.floodEmergencyRemaining > CONFIG.floodEmergencySeconds - 1);
  assert.ok(events.some(event => event.type === "flood-emergency-start"));
  assert.match(state.message, /полностью затоплена/i);
});

test("a flooded boat can be recovered with a patch and pump", () => {
  const state = createGame({mode: "coop", role: "crew", timed: false});
  startGame(state);
  state.boat.hull = 58;
  state.boat.water = 99.8;
  state.boat.leak = 4;
  step(state, 0.25);
  assert.equal(getView(state).damageControl.floodEmergency, true);

  const repair = command(state, "hull-repair", "crew");
  assert.equal(repair.ok, true);
  assert.equal(setControl(state, "pump", true, "crew"), true);
  const events = run(state, 18);
  setControl(state, "pump", false, "crew");

  const view = getView(state);
  assert.equal(state.lost, false);
  assert.equal(state.phase, "playing");
  assert.equal(view.damageControl.floodEmergency, false);
  assert.ok(state.boat.water <= CONFIG.floodRecoveryWater);
  assert.ok(state.boat.leak <= CONFIG.floodRecoveryLeak);
  assert.ok(events.some(event => event.type === "hull-repair-complete"));
  assert.ok(events.some(event => event.type === "flood-emergency-recovered"));
});

test("ignoring a fully flooded boat eventually ends the operation", () => {
  const state = createGame({mode: "coop", role: "crew", timed: false});
  startGame(state);
  state.boat.water = 99.8;
  state.boat.leak = 16;
  step(state, 0.25);
  const events = run(state, CONFIG.floodEmergencySeconds + 2);

  assert.equal(state.lost, true);
  assert.equal(state.phase, "finished");
  assert.equal(state.ending, "flooded");
  assert.ok(events.some(event => event.type === "flood-emergency-warning"));
  assert.ok(events.some(event => event.type === "flood-emergency-failed"));
});

test("movement state changes only when the boat actually gets underway", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);
  setControl(state, "forward", true);
  const startEvents = run(state, 1.2);
  setControl(state, "forward", false);
  assert.ok(startEvents.some(event => event.type === "motion-start"));
  assert.equal(getView(state).boat.moving, true);

  command(state, "anchor");
  const stopEvents = run(state, 12);
  assert.ok(stopEvents.some(event => event.type === "motion-stop"));
  assert.equal(getView(state).boat.motionState, "стоит");
});
