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

function validIntegrity(pairs) {
  return {
    sampledPairs: 0,
    sampledFrames: 0,
    nonZeroHistoryFrames: 0,
    diagnosticPairs: pairs,
    invalidDiagnosticPairs: 0,
    completedInterventions: 0,
    finalTickProofPairs: 0,
    invalidFinalTickProofs: 0,
    waterGuardInterventions: 0,
  };
}

function reportFor(shard, total = 10, shards = 3, startIndex = 100) {
  const pairs = expectedPairsForShard(total, shard, shards);
  return {
    format: "echo-neural-v2-pairs-v2",
    requestedPairs: total,
    completedPairs: pairs,
    authoritativeRollouts: pairs * 2,
    startIndex,
    endIndex: startIndex + total,
    shard,
    shards,
    minimumAdvantage: 2.5,
    positivePairs: 0,
    integrity: validIntegrity(pairs),
    baselineOutcomes: {victory: pairs},
    exploredOutcomes: {victory: pairs},
    advantageRange: {minimum: 0, maximum: 0, mean: 0},
    elitePairs: [],
  };
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
  const aggregate = mergeNeuralV2PairShards([reportFor(0), reportFor(2)], {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("missing-shard-1"));
  assert.ok(aggregate.failures.includes("aggregate-pairs-7-of-10"));
  assert.ok(aggregate.failures.includes("aggregate-rollouts-14-of-20"));
});

test("v2 aggregate rejects the obsolete discovery format", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => ({
    ...reportFor(shard),
    format: "echo-neural-v2-pairs-v1",
  }));
  const aggregate = mergeNeuralV2PairShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("format-mismatch-0"));
});

test("v2 aggregate rejects nonzero fake history and missing diagnostics", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => reportFor(shard));
  reports[1].integrity.nonZeroHistoryFrames = 3;
  reports[2].integrity.diagnosticPairs -= 1;
  reports[2].integrity.invalidDiagnosticPairs = 1;
  const aggregate = mergeNeuralV2PairShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("nonzero-history-frames-1-3"));
  assert.ok(aggregate.failures.includes("diagnostic-pairs-mismatch-2"));
  assert.ok(aggregate.failures.includes("invalid-diagnostic-pairs-2-1"));
});

test("v2 aggregate accepts a complete discovery batch with zero positive pairs", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => reportFor(shard));
  const aggregate = mergeNeuralV2PairShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "complete-discovery-batch");
  assert.equal(aggregate.completedPairs, 10);
  assert.equal(aggregate.authoritativeRollouts, 20);
  assert.equal(aggregate.positivePairs, 0);
  assert.equal(aggregate.integrity.diagnosticPairs, 10);
});
