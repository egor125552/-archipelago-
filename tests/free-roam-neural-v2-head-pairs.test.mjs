import assert from "node:assert/strict";
import test from "node:test";

import {
  createNeuralV2HeadPlan,
  simulateNeuralV2HeadPair,
} from "../training/generate_neural_v2_head_pairs.mjs";
import {
  expectedHeadPairsForShard,
  mergeNeuralV2HeadShards,
} from "../training/merge_neural_v2_head_pairs.mjs";

const HEADS = ["throttle", "steering", "range", "route", "fire"];

function integrity(pairs) {
  return {
    sampledPairs: 0,
    sampledFrames: 0,
    nonZeroHistoryFrames: 0,
    diagnosticPairs: pairs,
    invalidDiagnosticPairs: 0,
    completedInterventions: 0,
    finalTickProofPairs: 0,
    invalidFinalTickProofs: 0,
    isolatedHeadProofPairs: 0,
    invalidIsolatedHeadProofs: 0,
    waterGuardInterventions: 0,
  };
}

function reportFor(shard, total = 10, shards = 3, startIndex = 100) {
  const pairs = expectedHeadPairsForShard(total, shard, shards);
  const headPairCounts = {};
  for (let index = startIndex + shard; index < startIndex + total; index += shards) {
    const head = HEADS[Math.abs(index) % HEADS.length];
    headPairCounts[head] = (headPairCounts[head] || 0) + 1;
  }
  return {
    format: "echo-neural-v2-head-pairs-v1",
    requestedPairs: total,
    completedPairs: pairs,
    authoritativeRollouts: pairs * 2,
    startIndex,
    endIndex: startIndex + total,
    shard,
    shards,
    minimumAdvantage: 2.5,
    positivePairs: 0,
    headPairCounts,
    positiveByHead: {},
    valuePairCounts: {},
    positiveByValue: {},
    integrity: integrity(pairs),
    baselineOutcomes: {victory: pairs},
    exploredOutcomes: {victory: pairs},
    advantageRange: {minimum: 0, maximum: 0, mean: 0},
    elitePairs: [],
  };
}

test("single-head plans label exactly one balanced action head", () => {
  for (let index = 0; index < HEADS.length; index += 1) {
    const plan = createNeuralV2HeadPlan(5000 + index, 4, 45_000, index);
    assert.equal(plan.head, HEADS[index]);
    assert.equal(plan.headIndex, index);
    assert.equal(plan.action.head, plan.head);
    assert.equal(plan.action.isolated, true);
    assert.ok(Number.isInteger(plan.valueIndex));
  }
});

test("one real single-head pair proves only its selected head was applied", async () => {
  let pair = null;
  for (let attempt = 0; attempt < 5 && !pair; attempt += 1) {
    const candidate = await simulateNeuralV2HeadPair({
      battleIndex: 9_000 + attempt,
      durationMs: 12_000,
      level: 3,
      script: "idle-no-fire",
      coop: false,
    });
    const intervention = candidate.intervention;
    if (intervention.completed
      && intervention.appliedSamples === intervention.durationSamples
      && intervention.controlledFramesAtEnd > intervention.controlledFramesBeforeLastSample
      && intervention.isolatedHeadFramesAtEnd > intervention.isolatedHeadFramesBeforeLastSample) {
      pair = candidate;
    }
  }
  assert.ok(pair, "expected at least one fully completed isolated-head intervention");
  const selectedHead = pair.head;
  assert.ok(pair.explored.diagnostics.isolatedHeadFrames[selectedHead] > 0);
  for (const head of HEADS) {
    if (head !== selectedHead) assert.equal(pair.explored.diagnostics.isolatedHeadFrames[head], 0);
  }
  if (selectedHead === "fire") assert.equal(pair.explored.diagnostics.movementFrames, 0);
  else assert.ok(pair.explored.diagnostics.movementFrames > 0);
  for (const sample of pair.explored.samples) {
    assert.equal(sample.head, selectedHead);
    assert.equal(sample.headIndex, HEADS.indexOf(selectedHead));
    assert.equal(sample.valueIndex, pair.valueIndex);
    assert.deepEqual(sample.features.slice(-5), [0, 0, 0, 0, 0]);
  }
});

test("single-head shard accounting covers uneven ranges", () => {
  assert.equal(expectedHeadPairsForShard(10, 0, 3), 4);
  assert.equal(expectedHeadPairsForShard(10, 1, 3), 3);
  assert.equal(expectedHeadPairsForShard(10, 2, 3), 3);
});

test("single-head aggregate requires all five heads", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => reportFor(shard));
  const aggregate = mergeNeuralV2HeadShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "complete-single-head-discovery");
  for (const head of HEADS) assert.ok(aggregate.headPairCounts[head] > 0);
});

test("single-head aggregate rejects a mislabeled elite sample", () => {
  const reports = Array.from({length: 3}, (_unused, shard) => reportFor(shard));
  reports[0].positivePairs = 1;
  reports[0].positiveByHead = {steering: 1};
  reports[0].elitePairs = [{
    id: "bad-label",
    advantage: 3,
    head: "steering",
    valueIndex: 0,
    intervention: {
      head: "steering",
      valueIndex: 0,
      completed: true,
      finishAfterTick: false,
      controlledFramesBeforeLastSample: 10,
      controlledFramesAtEnd: 11,
      isolatedHeadFramesBeforeLastSample: 10,
      isolatedHeadFramesAtEnd: 11,
    },
    explored: {
      diagnostics: {
        preparedFrames: 11,
        controlledFrames: 11,
        movementFrames: 11,
        fireAllowedFrames: 0,
        fireSuppressedFrames: 0,
        waterClampFrames: 0,
        waterGuardInterventions: 0,
        missingActorFrames: 0,
        missingTargetFrames: 0,
        isolatedHeadFrames: {throttle: 0, steering: 11, range: 0, route: 0, fire: 0},
      },
      samples: [
        {head: "fire", valueIndex: 0, features: Array(53).fill(0)},
        {head: "fire", valueIndex: 0, features: Array(53).fill(0)},
      ],
    },
  }];
  const aggregate = mergeNeuralV2HeadShards(reports, {
    expectedPairs: 10,
    expectedShards: 3,
    expectedStartIndex: 100,
  });
  assert.equal(aggregate.verdict, "invalid");
  assert.ok(aggregate.failures.includes("elite-sample-label-mismatch-bad-label"));
});
