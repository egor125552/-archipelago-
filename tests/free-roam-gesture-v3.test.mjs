import test from "node:test";
import assert from "node:assert/strict";

import {directionFromDelta, isTwoFingerTap} from "../public/src/free-roam-gesture-model.js";

test("swipes resolve in all four directions", () => {
  assert.equal(directionFromDelta(0, -80), "up");
  assert.equal(directionFromDelta(0, 80), "down");
  assert.equal(directionFromDelta(-80, 0), "left");
  assert.equal(directionFromDelta(80, 0), "right");
  assert.equal(directionFromDelta(8, 10), null);
});

test("two-finger pump gesture rejects drags and slow taps", () => {
  assert.equal(isTwoFingerTap({maxPointers: 2, duration: 280, movements: [4, 8]}), true);
  assert.equal(isTwoFingerTap({maxPointers: 2, duration: 280, movements: [4, 45]}), false);
  assert.equal(isTwoFingerTap({maxPointers: 2, duration: 900, movements: [4, 8]}), false);
  assert.equal(isTwoFingerTap({maxPointers: 1, duration: 200, movements: [3]}), false);
});
