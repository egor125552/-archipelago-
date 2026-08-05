import test from "node:test";
import assert from "node:assert/strict";
import {ELITE_BOAT_RELEASE} from "../public/src/free-roam-elite-boat-version-v1.js";

test("elite boat 1.1 release contract remains explicit", () => {
  assert.deepEqual(ELITE_BOAT_RELEASE, {
    subsystem: "1.1.0",
    boatAudioClass: 44,
    bombReloadSeconds: 5,
    physicalTurrets: true,
    bombBayLifecycle: true,
    developerLogEliteSnapshot: true,
  });
});
