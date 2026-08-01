import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedDiagnosticPairsForShard,
  mergeNeuralV2HeadDiagnostics,
} from "../training/merge_neural_v2_head_diagnostics.mjs";

const HEADS = ["throttle", "steering", "range", "route", "fire"];

function stats(count = 0) {
  return {
    count,
    eligible: count,
    advantageSum: 0,
    minimum: count ? 0 : null,
    maximum: count ? 0 : null,
    thresholds: {"0": count, "1": 0, "2": 0, "2.5": 0},
  };
}

function reportFor(shard, total = 20, shards = 4, startIndex = 0) {
  const pairs = expectedDiagnosticPairsForShard(total, shard, shards);
  const headStats = Object.fromEntries(HEADS.map(head => [head, stats(0)]));
  for (let index = startIndex + shard; index < startIndex + total; index += shards) {
    headStats[HEADS[Math.abs(index) % HEADS.length]].count += 1;
    headStats[HEADS[Math.abs(index) % HEADS.length]].eligible += 1;
    headStats[HEADS[Math.abs(index) % HEADS.length]].thresholds["0"] += 1;
  }
  return {
    format: "echo-neural-v2-head-diagnostics-v1",
    requestedPairs: total,
    completedPairs: pairs,
    authoritativeRollouts: pairs * 2,
    startIndex,
    endIndex: startIndex + total,
    shard,
    shards,
    headStats,
    valueStats: {},
    integrity: {
      eligiblePairs: pairs,
      invalidPairs: 0,
      sampledFrames: pairs * 4,
      completedInterventions: pairs,
      finalTickProofPairs: pairs,
      isolatedHeadProofPairs: pairs,
      waterGuardInterventions: 0,
    },
    baselineOutcomes: {victory: pairs},
    exploredOutcomes: {victory: pairs},
    diagnosticPairs: [],
    trainingEligiblePairs: [],
  };
}

test("diagnostic shard accounting covers uneven ranges", () => {
  assert.equal(expectedDiagnosticPairsForShard(10, 0, 3), 4);
  assert.equal(expectedDiagnosticPairsForShard(10, 1, 3), 3);
  assert.equal(expectedDiagnosticPairsForShard(10, 2, 3), 3);
});

test("expanded diagnostics accepts a complete batch without training labels", () => {
  const reports = Array.from({length: 4}, (_unused, shard) => reportFor(shard));
  const aggregate = mergeNeuralV2HeadDiagnostics(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "complete-diagnostic-batch");
  assert.equal(aggregate.completedPairs, 20);
  assert.equal(aggregate.authoritativeRollouts, 40);
  assert.deepEqual(aggregate.trainingEligiblePairs, []);
  for (const head of HEADS) assert.ok(aggregate.headStats[head].count > 0);
});

test("expanded diagnostics rejects any attempted training labels", () => {
  const reports = Array.from({length: 4}, (_unused, shard) => reportFor(shard));
  reports[2].trainingEligiblePairs = [{id: "not-allowed"}];
  const aggregate = mergeNeuralV2HeadDiagnostics(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("training-pairs-present-2"));
});

test("expanded diagnostics rejects missing shards and invented rollouts", () => {
  const reports = [reportFor(0), reportFor(1), reportFor(3)];
  const aggregate = mergeNeuralV2HeadDiagnostics(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("missing-shard-2"));
  assert.ok(aggregate.failures.some(value => value.startsWith("aggregate-pairs-")));
  assert.ok(aggregate.failures.some(value => value.startsWith("aggregate-rollouts-")));
});
