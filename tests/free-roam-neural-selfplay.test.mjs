import assert from "node:assert/strict";
import test from "node:test";

import {
  previousActionFeatureState,
  selectEliteEpisodes,
  selfPlayScore,
} from "../training/generate_neural_selfplay_dataset.mjs";
import {compareCandidate} from "../training/compare_selfplay_candidate.mjs";

test("self-play score rewards resolved enemy pressure and penalizes guardrails", () => {
  const strong = selfPlayScore({
    outcome: "team-wipe",
    playerHealth: 0,
    boatHull: 15,
    boatWater: 40,
    enemyHits: 18,
    elapsedMs: 20_000,
    durationMs: 60_000,
    diagnostics: {waterGuardInterventions: 0, stuckEscapes: 0, shorelineRedirects: 0},
  });
  const guardedTimeout = selfPlayScore({
    outcome: "timeout",
    playerHealth: 65,
    boatHull: 70,
    boatWater: 8,
    enemyHits: 4,
    elapsedMs: 60_000,
    durationMs: 60_000,
    diagnostics: {waterGuardInterventions: 300, stuckEscapes: 8, shorelineRedirects: 200},
  });
  assert.ok(strong > guardedTimeout);
});

test("elite selection keeps the strongest episodes separately per threat level", () => {
  const selected = selectEliteEpisodes([
    {id: "a", level: 2, score: 1, seed: 1},
    {id: "b", level: 2, score: 9, seed: 2},
    {id: "c", level: 3, score: 4, seed: 3},
    {id: "d", level: 3, score: 7, seed: 4},
  ], 1);
  assert.deepEqual(selected.map(item => item.id), ["b", "d"]);
});

test("recurrent self-play features use the previous selected action", () => {
  const previous = new Map();
  assert.deepEqual(previousActionFeatureState(previous, "actor"), {movementIndex: 0, fire: false});
  previous.set("actor", {movementIndex: 3, fire: true});
  const captured = previousActionFeatureState(previous, "actor");
  assert.deepEqual(captured, {movementIndex: 3, fire: true});
  const currentLabel = {movementIndex: 1, fire: false};
  assert.notDeepEqual(captured, currentLabel);
});

test("candidate gate rejects water regressions even when pressure increases", () => {
  const base = {results: [{level: 5, outcome: "timeout", result: {playerHealth: 80, boatHull: 90, boatWater: 0}, metrics: {stationaryRatio: 0.1, invalidWaterRatio: 0}, mechanicalFailures: []}]};
  const candidate = {results: [{level: 5, outcome: "team-wipe", result: {playerHealth: 0, boatHull: 20, boatWater: 40}, metrics: {stationaryRatio: 0.1, invalidWaterRatio: 0.02}, mechanicalFailures: []}]};
  const report = compareCandidate(base, candidate);
  assert.equal(report.verdict, "rejected");
  assert.ok(report.failures.includes("water-legality-regressed"));
});
