import assert from "node:assert/strict";
import test from "node:test";

import {neuralV2ActionFeatureState} from "../src/free-roam-neural-v2-schema.js";

test("missing v2 action history is not replaced by a fake default manoeuvre", () => {
  assert.deepEqual(neuralV2ActionFeatureState(), [0, 0, 0, 0, 0]);
  assert.deepEqual(neuralV2ActionFeatureState({}), [0, 0, 0, 0, 0]);
  assert.deepEqual(neuralV2ActionFeatureState({source: "no-action"}), [0, 0, 0, 0, 0]);
});

test("an explicit previous v2 action is encoded independently by head", () => {
  const encoded = neuralV2ActionFeatureState({
    throttle: "full",
    steering: "right",
    range: "far",
    route: "shore_gate",
    fire: true,
  });
  assert.deepEqual(encoded, [1, 0.75, 2 / 3, 1, 1]);
});
