import test from "node:test";
import assert from "node:assert/strict";
import {createGame, startGame, setControl, step, CONFIG} from "../public/src/game-core-v5.js";

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...step(state, dt));
  return events;
}

test("complete mechanics loop: drive, coast, steer, damage, repair, pump, rescue and dock", () => {
  const state = createGame({mode: "solo", timed: false});
  startGame(state);

  setControl(state, "forward", true);
  run(state, 3);
  setControl(state, "forward", false);
  assert.ok(state.boat.speed > 8, `expected acceleration, got ${state.boat.speed}`);

  const releasedAt = state.boat.speed;
  run(state, 2);
  assert.ok(state.boat.speed > releasedAt * 0.8, `coasting lost too much speed: ${releasedAt} -> ${state.boat.speed}`);

  const headingBefore = state.boat.heading;
  setControl(state, "right", true);
  const turnEvents = run(state, 1.15);
  setControl(state, "right", false);
  run(state, 0.05);
  assert.ok(Math.abs(state.boat.heading - headingBefore) > 15);
  assert.ok(turnEvents.some(event => event.type === "turn-progress"));

  setControl(state, "reverse", true);
  run(state, 2);
  setControl(state, "reverse", false);
  assert.ok(Math.abs(state.boat.speed) < releasedAt * 0.75);

  const reef = state.world.hazards[0];
  state.boat.x = reef.x;
  state.boat.y = reef.y;
  state.boat.speed = 8;
  const collisionEvents = step(state, 0.05);
  assert.ok(collisionEvents.some(event => event.type === "collision"));
  assert.ok(state.boat.hull < 100 && state.boat.leak > 0);

  state.boat.speed = 0;
  setControl(state, "hullRepair", true);
  const repairEvents = run(state, CONFIG.hullRepairDuration + 0.25);
  assert.ok(repairEvents.some(event => event.type === "hull-repair-complete"));
  assert.equal(state.boat.repairPatches, 2);

  state.boat.water = 42;
  const waterBefore = state.boat.water;
  setControl(state, "pump", true);
  run(state, 2);
  setControl(state, "pump", false);
  assert.ok(state.boat.water < waterBefore);

  for (const survivor of state.world.survivors) {
    state.boat.x = survivor.x;
    state.boat.y = survivor.y;
    state.boat.speed = 0;
    setControl(state, "rescue", true);
    run(state, CONFIG.rescueDuration / 1.22 + 0.3);
    assert.equal(survivor.rescued, true);
  }
  assert.equal(state.rescued, 2);

  state.boat.x = state.world.harbor.x;
  state.boat.y = state.world.harbor.y;
  state.boat.speed = 2;
  step(state, 0.05);
  assert.equal(state.won, true);
  assert.equal(state.ending, "harbor");
});
