import assert from "node:assert/strict";
import test from "node:test";

import model from "../src/generated/free-roam-tactical-policy-v1.js";
import {createTacticalPolicyRuntime, verifyTacticalPolicyGolden} from "../src/free-roam-neural-policy.js";

test("quantized tactical policy matches the PyTorch golden inference", () => {
  const result = verifyTacticalPolicyGolden(model);
  assert.equal(result.ok, true, `maximum inference error ${result.maximumError}`);
  assert.ok(result.maximumError < 0.035);
});

test("tactical policy is recurrent and returns legal intents", () => {
  const runtime = createTacticalPolicyRuntime(model);
  const input = new Float32Array(model.inputSize);
  input[0] = 1;
  input[1] = 1;
  input[27] = 1;
  const first = runtime.step(input);
  const second = runtime.step(input, first.hidden);
  assert.equal(first.hidden.length, model.hiddenSize);
  assert.equal(model.movementClasses.includes(first.movement), true);
  assert.ok(first.fireProbability >= 0 && first.fireProbability <= 1);
  assert.notDeepEqual([...first.hidden], [...second.hidden]);
});
