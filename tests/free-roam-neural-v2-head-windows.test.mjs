import assert from "node:assert/strict";
import test from "node:test";

import {
  compareNeuralV2HeadWindow,
  simulateNeuralV2HeadWindowPair,
} from "../training/generate_neural_v2_head_windows.mjs";

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

function plan(head, value, action = {}) {
  return {head, value, action};
}

test("short-horizon comparison rejects mismatched actors", () => {
  const baseline = rollout(state(), state());
  const explored = {...rollout(state(), state()), actorId: "enemy-2"};
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
  const baseline = rollout(state(), state({heading: 5}));
  const explored = rollout(state(), state({heading: 40, x: 101}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {steering: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("steering", "right", {steering: "right"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.ok(result.objectiveDelta > 0);
  assert.ok(result.headingSeparation > 0);
});

test("range objective rewards getting closer to the requested range", () => {
  const baseline = rollout(state(), state({targetDistance: 80}));
  const explored = rollout(state(), state({targetDistance: 42, x: 102}), {
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
  const baseline = rollout(state(), state({boundaryMargin: 8}));
  const explored = rollout(state(), state({boundaryMargin: 19, x: 103}), {
    diagnostics: {
      waterGuardInterventions: 0,
      isolatedHeadEffects: {route: {changedFrames: 4}},
    },
  });
  const result = compareNeuralV2HeadWindow(plan("route", "safe_water", {route: "safe_water"}), baseline, explored);
  assert.equal(result.valid, true);
  assert.equal(result.objectiveDelta, 11);
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

test("one real short-horizon pair keeps actor identity and zero recurrent history", async () => {
  let pair = null;
  for (let attempt = 0; attempt < 8 && !pair; attempt += 1) {
    const candidate = await simulateNeuralV2HeadWindowPair({
      battleIndex: 12_000 + attempt,
      level: 4,
      script: "water-zigzag",
      coop: false,
      maximumMs: 18_000,
    });
    if (candidate.comparison.valid) pair = candidate;
  }
  assert.ok(pair, "expected at least one valid paired short-horizon window");
  assert.equal(pair.baseline.actorId, pair.explored.actorId);
  assert.equal(pair.baseline.actorRole, pair.explored.actorRole);
  assert.equal(pair.baseline.actorKind, pair.explored.actorKind);
  assert.equal(pair.baseline.initialState.actorId, pair.explored.initialState.actorId);
  assert.deepEqual(pair.baseline.initialState.features.slice(-5), [0, 0, 0, 0, 0]);
  assert.deepEqual(pair.explored.initialState.features.slice(-5), [0, 0, 0, 0, 0]);
  assert.equal(Number.isFinite(pair.comparison.objectiveDelta), true);
  assert.equal(Number.isFinite(pair.comparison.positionSeparation), true);
});
