import assert from "node:assert/strict";
import test from "node:test";

import {neuralBoatTargetPoint} from "../src/free-roam-neural-control.js";
import {collectNeuralActors} from "../src/free-roam-neural-shadow.js";
import {
  createServerFreeRoom,
  setServerFreePresence,
  startServerTrainingBattle,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {
  simulateAuthoritativeBattle,
  summarizeBattles,
} from "../training/run_real_server_simulations.mjs";

test("boat target on land is redirected to the production shore access", () => {
  assert.deepEqual(neuralBoatTargetPoint({x: 40, y: 20}), {
    x: 118,
    y: 88,
    redirectedFromLand: true,
  });
  assert.deepEqual(neuralBoatTargetPoint({x: 380, y: 30}), {
    x: 302,
    y: 88,
    redirectedFromLand: true,
  });
  assert.deepEqual(neuralBoatTargetPoint({x: 210, y: 180}), {
    x: 210,
    y: 180,
    redirectedFromLand: false,
  });
});

test("threat five exposes the heavy hull and turret as separate neural actors", () => {
  const server = createServerFreeRoom(1_000);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level: 5, neuralOnly: true}, false, 1_040);
  tickServerFreeRoom(server, 1_240);
  const actors = collectNeuralActors(server.world);
  const heavy = actors.find(actor => actor.role === "heavy");
  const turret = actors.find(actor => actor.role === "heavy_turret");
  assert.ok(heavy);
  assert.ok(turret);
  assert.equal(heavy.controlsMovement, true);
  assert.equal(heavy.controlsFire, false);
  assert.equal(turret.controlsMovement, false);
  assert.equal(turret.controlsFire, true);
  assert.notEqual(heavy.id, turret.id);
});

test("authoritative level-five simulation rejects a silent heavy turret", async () => {
  const result = await simulateAuthoritativeBattle({
    battleIndex: 5,
    seed: 125_557,
    durationMs: 16_000,
    level: 5,
    script: "water-zigzag",
    coop: false,
  });
  assert.equal(result.metrics.invalidWaterSamples, 0);
  assert.equal(result.metrics.neuralControlMissingSamples, 0);
  assert.equal(result.metrics.heavyTurretFailed, false);
  assert.ok(result.metrics.heavyTurretWindups > 0 || result.metrics.heavyTurretShots > 0);
  assert.doesNotMatch(result.failedChecks.join(","), /heavy-turret-never-activated|water-boundary-violation/);
});

test("aggregate report states requested and completed battles separately", async () => {
  const results = [
    await simulateAuthoritativeBattle({battleIndex: 0, seed: 125_552, durationMs: 4_000, level: 2, script: "idle"}),
    await simulateAuthoritativeBattle({battleIndex: 1, seed: 125_553, durationMs: 4_000, level: 3, script: "water-escape"}),
  ];
  const summary = summarizeBattles(results, 1_000_000);
  assert.equal(summary.requestedBattles, 1_000_000);
  assert.equal(summary.completedBattles, 2);
  assert.ok(summary.critique.some(item => item.includes("does not itself retrain")));
});
