import test from "node:test";
import assert from "node:assert/strict";

import {relativeMovementPan} from "../public/src/free-roam-audio-v3.js";

test("remote footsteps pan relative to listener heading", () => {
  const listener = {x: 100, y: 100, heading: 0};
  assert.ok(relativeMovementPan(listener, {x: 120, y: 100}) > 0.9);
  assert.ok(relativeMovementPan(listener, {x: 80, y: 100}) < -0.9);
  assert.ok(Math.abs(relativeMovementPan(listener, {x: 100, y: 70})) < 0.05);
});

test("turning the listener rotates the audible side", () => {
  const listener = {x: 100, y: 100, heading: 180};
  assert.ok(relativeMovementPan(listener, {x: 120, y: 100}) < -0.9);
});
