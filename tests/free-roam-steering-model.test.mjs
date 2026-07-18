import test from "node:test";
import assert from "node:assert/strict";

import {operationSteeringDelta, shouldCenterRudder} from "../public/src/free-roam-steering-model.js";

test("operation steering gives usable authority at low and cruising speed", () => {
  const low = operationSteeringDelta(0.4, 1, 0.1);
  const cruise = operationSteeringDelta(9, 1, 0.1);
  assert.ok(low > 1);
  assert.ok(cruise > low);
  assert.equal(operationSteeringDelta(9, -1, 0.1), -cruise);
});

test("reverse steering changes heading in the opposite physical direction", () => {
  assert.ok(operationSteeringDelta(-6, 1, 0.1) < 0);
});

test("released wheel requests immediate rudder centering", () => {
  assert.equal(shouldCenterRudder(0), true);
  assert.equal(shouldCenterRudder(1), false);
  assert.equal(shouldCenterRudder(-1), false);
});
