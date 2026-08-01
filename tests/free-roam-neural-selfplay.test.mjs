import assert from "node:assert/strict";
import test from "node:test";

import {
  previousActionFeatureState,
  selectEliteEpisodes,
  selfPlayScore,
} from "../training/generate_neural_selfplay_dataset.mjs";
import {compareCandidate} from "../training/compare_selfplay_candidate.mjs";
import {
  expectedBattlesForShard,
  mergeSelfPlayShards,
} from "../training/merge_neural_selfplay_shards.mjs";

const actorSamples = [{samples: [{}, {}, {}, {}]}];

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

test("elite selection preserves threat, script and solo/co-op coverage", () => {
  const selected = selectEliteEpisodes([
    {id: "a", level: 2, script: "shoreline", coop: false, score: 1, seed: 1, actors: actorSamples},
    {id: "b", level: 2, script: "shoreline", coop: false, score: 9, seed: 2, actors: actorSamples},
    {id: "c", level: 2, script: "water-escape", coop: false, score: 4, seed: 3, actors: actorSamples},
    {id: "d", level: 2, script: "shoreline", coop: true, score: 7, seed: 4, actors: actorSamples},
    {id: "empty", level: 3, script: "shoreline", coop: false, score: 99, seed: 5, actors: []},
  ], 1);
  assert.deepEqual(new Set(selected.map(item => item.id)), new Set(["b", "c", "d"]));
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

test("self-play aggregate rejects a missing shard instead of inventing completion", () => {
  assert.equal(expectedBattlesForShard(10, 0, 3), 4);
  assert.equal(expectedBattlesForShard(10, 1, 3), 3);
  const makeReport = shard => ({
    format: "echo-neural-selfplay-elites-v1",
    requestedBattles: 10,
    completedBattles: expectedBattlesForShard(10, shard, 3),
    startIndex: 50,
    endIndex: 60,
    shard,
    shards: 3,
    outcomeCounts: {victory: expectedBattlesForShard(10, shard, 3)},
    scoreRange: {minimum: 1, maximum: 2},
    eliteEpisodes: [{id: `elite-${shard}`}],
  });
  const incomplete = mergeSelfPlayShards([makeReport(0), makeReport(2)], {
    expectedBattles: 10,
    expectedShards: 3,
    expectedStartIndex: 50,
  });
  assert.equal(incomplete.verdict, "incomplete");
  assert.ok(incomplete.failures.includes("missing-shard-1"));
});

test("candidate gate rejects an unchanged model", () => {
  const report = {
    results: [{
      level: 5,
      script: "shoreline",
      coop: false,
      outcome: "timeout",
      result: {playerHealth: 80, boatHull: 90, boatWater: 0},
      metrics: {stationaryRatio: 0.1, invalidWaterRatio: 0},
      mechanicalFailures: [],
    }],
  };
  const comparison = compareCandidate(report, structuredClone(report));
  assert.equal(comparison.verdict, "rejected");
  assert.ok(comparison.failures.includes("no-measurable-held-out-improvement"));
});

test("candidate gate rejects a scenario regression hidden by aggregate gain", () => {
  const make = (script, pressureHealth) => ({
    level: 5,
    script,
    coop: false,
    outcome: "timeout",
    result: {playerHealth: pressureHealth, boatHull: 100, boatWater: 0},
    metrics: {stationaryRatio: 0, invalidWaterRatio: 0},
    mechanicalFailures: [],
  });
  const base = {results: [make("shoreline", 85), make("water-zigzag", 90)]};
  const candidate = {results: [make("shoreline", 98), make("water-zigzag", 40)]};
  const report = compareCandidate(base, candidate);
  assert.equal(report.verdict, "rejected");
  assert.ok(report.failures.includes("scenario-pressure-regressed-5:shoreline:solo"));
});

test("candidate gate rejects water regressions even when pressure increases", () => {
  const base = {results: [{level: 5, script: "water-zigzag", coop: false, outcome: "timeout", result: {playerHealth: 80, boatHull: 90, boatWater: 0}, metrics: {stationaryRatio: 0.1, invalidWaterRatio: 0}, mechanicalFailures: []}]};
  const candidate = {results: [{level: 5, script: "water-zigzag", coop: false, outcome: "team-wipe", result: {playerHealth: 0, boatHull: 20, boatWater: 40}, metrics: {stationaryRatio: 0.1, invalidWaterRatio: 0.02}, mechanicalFailures: []}]};
  const report = compareCandidate(base, candidate);
  assert.equal(report.verdict, "rejected");
  assert.ok(report.failures.includes("water-legality-regressed"));
});
