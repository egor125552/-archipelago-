import assert from "node:assert/strict";
import test from "node:test";

import {assessNeuralV2TrainingReadiness} from "../training/assess_neural_v2_training_readiness.mjs";

const HEADS = ["throttle", "steering", "range", "route", "fire"];

function aggregate({positives = 8, positiveValues = [0, 1]} = {}) {
  const headStats = {};
  const valueStats = {};
  for (const head of HEADS) {
    headStats[head] = {
      eligible: 100,
      thresholds: {"2.5": positives},
    };
    for (const value of positiveValues) {
      valueStats[`${head}:${value}`] = {thresholds: {"2.5": Math.ceil(positives / positiveValues.length)}};
    }
  }
  return {
    format: "echo-neural-v2-head-diagnostics-aggregate-v1",
    verdict: "complete-diagnostic-batch",
    headStats,
    valueStats,
    trainingEligiblePairs: [],
  };
}

test("readiness rejects sparse evidence concentrated in throttle", () => {
  const source = aggregate({positives: 0, positiveValues: []});
  source.headStats.throttle.thresholds["2.5"] = 2;
  source.valueStats["throttle:3"] = {thresholds: {"2.5": 2}};
  const report = assessNeuralV2TrainingReadiness(source);
  assert.equal(report.verdict, "not-ready-for-training");
  assert.equal(report.trainingAllowed, false);
  assert.ok(report.failures.includes("throttle:positives-2-below-8"));
  assert.ok(report.failures.includes("steering:positives-0-below-8"));
  assert.ok(report.failures.includes("positive-evidence-dominated-by-throttle"));
});

test("readiness rejects diagnostic artifacts containing training labels", () => {
  const source = aggregate();
  source.trainingEligiblePairs = [{id: "forbidden"}];
  const report = assessNeuralV2TrainingReadiness(source);
  assert.equal(report.trainingAllowed, false);
  assert.ok(report.failures.includes("diagnostic-artifact-already-contains-training-labels"));
});

test("readiness allows masked trainer development only with broad head and value coverage", () => {
  const report = assessNeuralV2TrainingReadiness(aggregate());
  assert.equal(report.verdict, "ready-for-masked-trainer-development");
  assert.equal(report.trainingAllowed, true);
  assert.equal(report.failures.length, 0);
  for (const head of HEADS) assert.equal(report.headReadiness[head].ready, true);
});
