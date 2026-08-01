import assert from "node:assert/strict";
import test from "node:test";

import {
  compareNeuralV2HeadWindow,
  simulateNeuralV2HeadWindowPair,
} from "../training/generate_neural_v2_head_windows.mjs";

const HEADS = ["throttle", "steering", "range", "route", "fire"];

function state(overrides = {}) {
  return {
    actorId: "enemy-1",
    role: "interceptor",
    kind: "boat",
    x: 100,
    y: 150,
    heading: 0,
    speed: 10,
    targetX: 100,
    targetY: 100,
    targetDistance: 50,
    gateDistance: 60,
    boundaryMargin: 40,
    baseMovement: "approach",
    baseFire: false,
    playerHealth: 100,
    playerBoatHull: 100,
    playerBoatWater: 0,
    features: Array(53).fill(0),
    ...overrides,
  };
}

function rollout(initial, final, overrides = {}) {
  return {
    completed: true,
    actorId: "enemy-1",
    actorRole: "interceptor",
    actorKind: "boat",
    diagnosticAssistFrames: 0,
    initialState: initial,
    finalState: final,
    enemyPressureEvents: 0,
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {
        throttle: {changedFrames: 0},
        steering: {changedFrames: 0},
        range: {changedFrames: 0},
        route: {changedFrames: 0},
        fire: {changedFrames: 0},
      },
    },
    ...overrides,
  };
}

function assistedRollout(initial, final, overrides = {}) {
  return rollout(initial, final, {diagnosticAssistFrames: 4, ...overrides});
}

function plan(head, value, action = {}) {
  return {head, value, action};
}

test("short-horizon comparison rejects mismatched actors", () => {
  const baseline = assistedRollout(state(), state());
  const explored = {...assistedRollout(state(), state()), actorId: "enemy-2"};
  const result = compareNeuralV2HeadWindow(plan("steering", "right"), baseline, explored);
  assert.equal(result.valid, false);
  assert.ok(result.failures.includes("actor-id-mismatch"));
});

test("throttle objective rewards movement toward the requested speed", () => {
  const baseline = rollout(state(), state({speed: 5}));
  const explored = rollout(state(), state({speed: 14, x: 101}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {throttle: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("throttle", "full", {throttle: "full"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.equal(result.changed, true);
  assert.ok(result.objectiveDelta > 0);
  assert.ok(result.speedSeparation > 0);
});

test("steering objective rewards the requested turn direction", () => {
  const baseline = assistedRollout(state(), state({heading: 5}));
  const explored = assistedRollout(state(), state({heading: 40, x: 101}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {steering: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("steering", "right", {steering: "right"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.ok(result.objectiveDelta > 0);
  assert.ok(result.headingSeparation > 0);
  assert.equal(result.diagnosticAssistFrames, 4);
});

test("range objective rewards getting closer to the requested range", () => {
  const baseline = assistedRollout(state(), state({targetDistance: 80}));
  const explored = assistedRollout(state(), state({targetDistance: 42, x: 102}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {range: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("range", "medium", {range: "medium"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.ok(result.objectiveDelta > 0);
});

test("safe-water route rewards a larger water-boundary margin", () => {
  const baseline = assistedRollout(state(), state({boundaryMargin: 8}));
  const explored = assistedRollout(state(), state({boundaryMargin: 19, x: 103}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {route: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("route", "safe_water", {route: "safe_water"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.equal(result.objectiveDelta, 11);
});

test("directional comparison rejects asymmetric diagnostic motion", () => {
  const baseline = assistedRollout(state(), state({heading: 5}));
  const explored = assistedRollout(state(), state({heading: 40}), {diagnosticAssistFrames: 3});
  const result = compareNeuralV2HeadWindow(plan("steering", "right", {steering: "right"}), baseline, explored);
  assert.equal(result.valid, false);
  assert.ok(result.failures.includes("motion-assist-frame-mismatch"));
});

test("fire objective uses immediate enemy pressure without inventing movement", () => {
  const baseline = rollout(state(), state(), {enemyPressureEvents: 1});
  const explored = rollout(state(), state(), {
    enemyPressureEvents: 3,
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {fire: {changedFrames: 2}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("fire", "fire", {fire: true}), baseline, explored);
  assert.equal(result.valid, true);
  assert.equal(result.objectiveDelta, 2);
  assert.equal(result.positionSeparation, 0);
});

async function findValidHeadWindow(headIndex) {
  const attempts = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const battleIndex = 15_000 + headIndex + attempt * HEADS.length;
    const candidate = await simulateNeuralV2HeadWindowPair({
      battleIndex,
      level: 5,
      script: "idle-no-fire",
      coop: false,
      maximumMs: 24_000,
    });
    attempts.push({
      battleIndex,
      head: candidate.head,
      baselineStarted: candidate.baseline.started,
      baselineCompleted: candidate.baseline.completed,
      exploredStarted: candidate.explored.started,
      exploredCompleted: candidate.explored.completed,
      baselineActor: candidate.baseline.actorId,
      exploredActor: candidate.explored.actorId,
      baselineAssist: candidate.baseline.diagnosticAssistFrames,
      exploredAssist: candidate.explored.diagnosticAssistFrames,
      failures: candidate.comparison.failures,
    });
    if (candidate.comparison.valid) return {candidate, attempts};
  }
  return {candidate: null, attempts};
}

test("every v2 head can produce one identity-matched short-horizon window", async () => {
  for (let headIndex = 0; headIndex < HEADS.length; headIndex += 1) {
    const {candidate, attempts} = await findValidHeadWindow(headIndex);
    assert.ok(candidate, `${HEADS[headIndex]} had no valid window: ${JSON.stringify(attempts)}`);
    assert.equal(candidate.head, HEADS[headIndex]);
    assert.equal(candidate.baseline.actorId, candidate.explored.actorId);
    assert.equal(candidate.baseline.actorRole, candidate.explored.actorRole);
    assert.equal(candidate.baseline.actorKind, candidate.explored.actorKind);
    assert.equal(candidate.baseline.initialState.actorId, candidate.explored.initialState.actorId);
    assert.deepEqual(candidate.baseline.initialState.features.slice(-5), [0, 0, 0, 0, 0]);
    assert.deepEqual(candidate.explored.initialState.features.slice(-5), [0, 0, 0, 0, 0]);
    assert.equal(Number.isFinite(candidate.comparison.objectiveDelta), true);
    assert.equal(Number.isFinite(candidate.comparison.positionSeparation), true);
    if (["steering", "range", "route"].includes(candidate.head)) {
      assert.ok(candidate.baseline.diagnosticAssistFrames > 0);
      assert.equal(candidate.baseline.diagnosticAssistFrames, candidate.explored.diagnosticAssistFrames);
    }
  }
});
