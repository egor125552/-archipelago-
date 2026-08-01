import assert from "node:assert/strict";
import test from "node:test";

import {
  createInterventionPlan,
  previousActionFeatureState,
  seededRandom,
  selectEliteEpisodes,
  selfPlayScore,
  withWorldRandomSeed,
} from "../training/generate_neural_selfplay_dataset.mjs";
import {compareCandidate} from "../training/compare_selfplay_candidate.mjs";
import {
  expectedBattlesForShard,
  mergeSelfPlayShards,
} from "../training/merge_neural_selfplay_shards.mjs";

const actorSamples = [{samples: [{em: 1}, {}, {}, {}]}];
const movementIntervention = {kind: "movement", started: true, appliedSamples: 4};

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
  const guardedVictory = selfPlayScore({
    outcome: "victory",
    playerHealth: 65,
    boatHull: 70,
    boatWater: 8,
    enemyHits: 4,
    elapsedMs: 60_000,
    durationMs: 60_000,
    diagnostics: {waterGuardInterventions: 300, stuckEscapes: 8, shorelineRedirects: 200},
  });
  assert.ok(strong > guardedVictory);
});

test("exploration random numbers do not consume production random numbers", async () => {
  const expected = seededRandom(77);
  const expectedValues = [expected(), expected()];
  const actualValues = await withWorldRandomSeed(77, async () => {
    const first = Math.random();
    const exploration = seededRandom(999);
    for (let index = 0; index < 20; index += 1) exploration();
    return [first, Math.random()];
  });
  assert.deepEqual(actualValues, expectedValues);
});

test("an intervention plan describes one bounded coherent macro", () => {
  const first = createInterventionPlan(125552, 45_000, 0.72);
  const second = createInterventionPlan(125552, 45_000, 0.72);
  assert.deepEqual(first, second);
  assert.ok(["movement", "fire"].includes(first.kind));
  assert.ok(first.durationSamples >= 4 && first.durationSamples <= 10);
  assert.ok(first.startAtMs >= 1000 && first.startAtMs <= 39_000);
  assert.equal(first.actorId, null);
  assert.equal(first.appliedSamples, 0);
});

test("elite selection preserves scenario coverage and requires one completed positive macro", () => {
  const selected = selectEliteEpisodes([
    {id: "a", level: 2, script: "shoreline", coop: false, advantage: 1, score: 100, seed: 1, actors: actorSamples, intervention: movementIntervention},
    {id: "b", level: 2, script: "shoreline", coop: false, advantage: 9, score: 9, seed: 2, actors: actorSamples, intervention: movementIntervention},
    {id: "c", level: 2, script: "water-escape", coop: false, advantage: 4, score: 4, seed: 3, actors: actorSamples, intervention: movementIntervention},
    {id: "d", level: 2, script: "shoreline", coop: true, advantage: 7, score: 7, seed: 4, actors: actorSamples, intervention: movementIntervention},
    {id: "no-explore", level: 3, script: "shoreline", coop: false, advantage: 99, score: 99, seed: 5, actors: [{samples: [{}, {}, {}, {}]}], intervention: movementIntervention},
    {id: "too-short", level: 3, script: "shoreline", coop: false, advantage: 99, score: 99, seed: 6, actors: actorSamples, intervention: {kind: "movement", started: true, appliedSamples: 1}},
  ], 1, 2.5);
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

test("paired aggregate rejects a missing shard instead of inventing completion", () => {
  assert.equal(expectedBattlesForShard(10, 0, 3), 4);
  assert.equal(expectedBattlesForShard(10, 1, 3), 3);
  const makeReport = shard => {
    const completed = expectedBattlesForShard(10, shard, 3);
    return {
      format: "echo-neural-selfplay-elites-v3",
      requestedBattles: 10,
      completedBattles: completed,
      authoritativeRollouts: completed * 2,
      startIndex: 50,
      endIndex: 60,
      shard,
      shards: 3,
      baselineOutcomeCounts: {victory: completed},
      exploredOutcomeCounts: {victory: completed},
      interventionCounts: {movement: completed, fire: 0, notStarted: 0},
      positiveAdvantagePairs: completed,
      advantageRange: {minimum: 3, maximum: 5, mean: 4},
      scoreRange: {minimum: 1, maximum: 2},
      eliteEpisodes: [{id: `elite-${shard}`, advantage: 3, intervention: movementIntervention}],
    };
  };
  const incomplete = mergeSelfPlayShards([makeReport(0), makeReport(2)], {
    expectedBattles: 10,
    expectedShards: 3,
    expectedStartIndex: 50,
  });
  assert.equal(incomplete.verdict, "incomplete");
  assert.ok(incomplete.failures.includes("missing-shard-1"));
  assert.ok(incomplete.failures.some(item => item.startsWith("aggregate-rollouts-")));
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
