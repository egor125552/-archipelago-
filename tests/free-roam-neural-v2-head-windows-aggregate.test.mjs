import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedWindowPairsForShard,
  mergeNeuralV2HeadWindows,
} from "../training/merge_neural_v2_head_windows.mjs";

const HEADS = ["throttle", "steering", "range", "route", "fire"];

function stats(pairs = 0) {
  return {
    pairs,
    valid: pairs,
    changed: pairs,
    objectivePositive: pairs,
    objectiveNegative: 0,
    objectiveSum: pairs,
    positionSeparationSum: pairs,
    headingSeparationSum: pairs,
    speedSeparationSum: pairs,
    waterGuardDeltaSum: 0,
  };
}

function reportFor(shard, total = 20, shards = 4, startIndex = 0) {
  const pairs = expectedWindowPairsForShard(total, shard, shards);
  const headStats = Object.fromEntries(HEADS.map(head => [head, stats(0)]));
  for (let index = startIndex + shard; index < startIndex + total; index += shards) {
    const head = HEADS[Math.abs(index) % HEADS.length];
    headStats[head] = stats(headStats[head].pairs + 1);
  }
  return {
    format: "echo-neural-v2-head-windows-v1",
    requestedPairs: total,
    completedPairs: pairs,
    authoritativeRollouts: pairs * 2,
    startIndex,
    endIndex: startIndex + total,
    shard,
    shards,
    maximumMs: 30_000,
    validPairs: pairs,
    invalidPairs: 0,
    changedPairs: pairs,
    objectivePositivePairs: pairs,
    headStats,
    diagnosticPairs: [],
    trainingEligiblePairs: [],
  };
}

test("short-horizon shard accounting covers uneven ranges", () => {
  assert.equal(expectedWindowPairsForShard(10, 0, 3), 4);
  assert.equal(expectedWindowPairsForShard(10, 1, 3), 3);
  assert.equal(expectedWindowPairsForShard(10, 2, 3), 3);
});

test("short-horizon aggregate accepts complete diagnostic evidence only", () => {
  const reports = Array.from({length: 4}, (_unused, shard) => reportFor(shard));
  const aggregate = mergeNeuralV2HeadWindows(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "complete-short-horizon-diagnostics");
  assert.equal(aggregate.completedPairs, 20);
  assert.equal(aggregate.authoritativeRollouts, 40);
  assert.equal(aggregate.validPairs, 20);
  assert.deepEqual(aggregate.trainingEligiblePairs, []);
  for (const head of HEADS) assert.ok(aggregate.headStats[head].pairs > 0);
});

test("short-horizon aggregate rejects missing shards and invented rollouts", () => {
  const reports = [reportFor(0), reportFor(1), reportFor(3)];
  const aggregate = mergeNeuralV2HeadWindows(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("missing-shard-2"));
  assert.ok(aggregate.failures.some(value => value.startsWith("aggregate-pairs-")));
  assert.ok(aggregate.failures.some(value => value.startsWith("aggregate-rollouts-")));
});

test("short-horizon aggregate rejects attempted training labels", () => {
  const reports = Array.from({length: 4}, (_unused, shard) => reportFor(shard));
  reports[1].trainingEligiblePairs = [{id: "forbidden"}];
  const aggregate = mergeNeuralV2HeadWindows(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("training-pairs-present-1"));
});

test("short-horizon aggregate rejects actor identity mismatch in diagnostics", () => {
  const reports = Array.from({length: 4}, (_unused, shard) => reportFor(shard));
  const finite = {
    actorId: "enemy-a",
    role: "interceptor",
    kind: "boat",
    x: 100,
    y: 120,
    heading: 0,
    speed: 8,
    targetX: 100,
    targetY: 80,
    targetDistance: 40,
    gateDistance: 50,
    boundaryMargin: 20,
    playerHealth: 100,
    playerBoatHull: 100,
    playerBoatWater: 0,
    features: Array(53).fill(0),
  };
  reports[0].diagnosticPairs = [{
    id: "bad-actor",
    head: "steering",
    valueIndex: 0,
    battleIndex: 0,
    comparison: {
      valid: true,
      objectiveDelta: 1,
      headingSeparation: 10,
      speedSeparation: 0,
      positionSeparation: 1,
      targetDistanceDelta: 0,
      boundaryMarginDelta: 0,
      gateDistanceDelta: 0,
      pressureDelta: 0,
      playerDamageDelta: 0,
      boatDamageDelta: 0,
      waterGuardDelta: 0,
    },
    baseline: {
      completed: true,
      actorId: "enemy-a",
      actorRole: "interceptor",
      actorKind: "boat",
      initialState: finite,
      finalState: finite,
    },
    explored: {
      completed: true,
      actorId: "enemy-b",
      actorRole: "interceptor",
      actorKind: "boat",
      initialState: {...finite, actorId: "enemy-b"},
      finalState: {...finite, actorId: "enemy-b"},
    },
  }];
  const aggregate = mergeNeuralV2HeadWindows(reports, {
    expectedPairs: 20,
    expectedShards: 4,
    expectedStartIndex: 0,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("invalid-diagnostic-pair-bad-actor"));
});
