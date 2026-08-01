import assert from "node:assert/strict";
import test from "node:test";

import {
  createNeuralV2PairPlan,
  simulateNeuralV2Pair,
} from "../training/generate_neural_v2_pairs.mjs";
import {
  expectedPairsForShard,
  mergeNeuralV2PairShards,
} from "../training/merge_neural_v2_pairs.mjs";

function validAction(action) {
  return action.throttleIndex >= 0 && action.throttleIndex < 4
    && action.steeringIndex >= 0 && action.steeringIndex < 5
    && action.rangeIndex >= 0 && action.rangeIndex < 4
    && action.routeIndex >= 0 && action.routeIndex < 3
    && action.fireIndex >= 0 && action.fireIndex < 2;
}

test("v2 pair plans are deterministic, bounded and start early on threat two", () => {
  const first = createNeuralV2PairPlan(125552, 2, 45_000);
  const second = createNeuralV2PairPlan(125552, 2, 45_000);
  assert.deepEqual(first, second);
  assert.ok(first.startAtMs >= 400 && first.startAtMs <= 2200);
  assert.ok(first.durationSamples >= 4 && first.durationSamples <= 11);
  assert.equal(validAction(first.action), true);
  assert.equal(first.started, false);
  assert.equal(first.appliedSamples, 0);
  assert.equal(first.controlledFramesBeforeLastSample, null);
  assert.equal(first.controlledFramesAtEnd, null);
});

test("the final recorded v2 sample is applied by an authoritative server tick", async () => {
  const pair = await simulateNeuralV2Pair({
    battleIndex: 9_001,
    durationMs: 20_000,
    level: 5,
    script: "idle-no-fire",
    coop: false,
  });
  assert.equal(pair.intervention.started, true);
  assert.equal(pair.intervention.completed, true);
  assert.equal(pair.intervention.finishAfterTick, false);
  assert.equal(pair.intervention.appliedSamples, pair.intervention.durationSamples);
  assert.ok(pair.intervention.controlledFramesAtEnd > pair.intervention.controlledFramesBeforeLastSample);
  assert.ok(pair.explored.diagnostics.controlledFrames >= pair.intervention.controlledFramesAtEnd);
  assert.ok(pair.explored.samples.length >= pair.intervention.durationSamples);
  for (const sample of pair.explored.samples) assert.deepEqual(sample.features.slice(-5), [0, 0, 0, 0, 0]);
});

test("v2 shard accounting covers uneven pair counts exactly", () => {
  assert.equal(expectedPairsForShard(10, 0, 3), 4);
  assert.equal(expectedPairsForShard(10, 1, 3), 3);
  assert.equal(expectedPairsForShard(10, 2, 3), 3);
});

test("v2 aggregate rejects a missing shard instead of inventing 512 rollouts", () => {
  const makeReport = shard => {
    const pairs = expectedPairsForShard(10, shard, 3);
    return {
      format: "echo-neural-v2-pairs-v1",
      requestedPairs: 10,
      completedPairs: pairs,
      authoritativeRollouts: pairs * 2,
      startIndex: 100,
      endIndex: 110,
      shard,
      shards: 3,
      minimumAdvantage: 2.5,
      positivePairs: 0,
      baselineOutcomes: {victory: pairs},
      exploredOutcomes: {victory: pairs},
      advantageRange: {minimum: 0, maximum: 0, mean: 0},
      elitePairs: [],
    };
  };
  const aggregate = mergeNeuralV2PairShards([makeReport(0), makeReport(2)], {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("missing-shard-1"));
  assert.ok(aggregate.failures.includes("aggregate-pairs-7-of-10"));
  assert.ok(aggregate.failures.includes("aggregate-rollouts-14-of-20"));
});

test("v2 aggregate accepts a complete discovery batch with zero positive pairs", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => {
    const pairs = expectedPairsForShard(10, shard, 3);
    return {
      format: "echo-neural-v2-pairs-v1",
      requestedPairs: 10,
      completedPairs: pairs,
      authoritativeRollouts: pairs * 2,
      startIndex: 100,
      endIndex: 110,
      shard,
      shards: 3,
      minimumAdvantage: 2.5,
      positivePairs: 0,
      baselineOutcomes: {victory: pairs},
      exploredOutcomes: {victory: pairs},
      advantageRange: {minimum: 0, maximum: 0, mean: 0},
      elitePairs: [],
    };
  });
  const aggregate = mergeNeuralV2PairShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "complete-discovery-batch");
  assert.equal(aggregate.completedPairs, 10);
  assert.equal(aggregate.authoritativeRollouts, 20);
  assert.equal(aggregate.positivePairs, 0);
});
