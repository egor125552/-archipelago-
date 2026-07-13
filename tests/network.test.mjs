import test from "node:test";
import assert from "node:assert/strict";
import {normalizeRoomCode} from "../public/src/network.js";

test("room codes contain only ASCII letters and digits", () => {
  assert.equal(normalizeRoomCode("н"), "H");
  assert.equal(normalizeRoomCode("волна7"), "BOHA7");
  assert.match(normalizeRoomCode("echo-Н 42"), /^[A-Z0-9]{1,6}$/);
});

test("room codes are trimmed and capped at six characters", () => {
  assert.equal(normalizeRoomCode("  ABCD-1234  "), "ABCD12");
  assert.equal(normalizeRoomCode(""), "");
});
