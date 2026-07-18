import test from "node:test";
import assert from "node:assert/strict";

import {operationEventForFreeEvent} from "../public/src/free-roam-audio.js";

test("free-roam mechanics map onto familiar operation sound events", () => {
  assert.deepEqual(operationEventForFreeEvent({type: "tow-attach"}), {type: "rope"});
  assert.deepEqual(operationEventForFreeEvent({type: "tow-strain", tension: 0.8}), {type: "rope-strain", speed: 0.8});
  assert.deepEqual(operationEventForFreeEvent({type: "tow-detach"}), {type: "rope-far"});
  assert.deepEqual(operationEventForFreeEvent({type: "pump-start"}), {type: "pump-start"});
  assert.deepEqual(operationEventForFreeEvent({type: "hull-repair-start"}), {type: "hull-repair-start"});
  assert.deepEqual(operationEventForFreeEvent({type: "hull-repair-progress", percent: 50}), {type: "hull-repair-progress", percent: 50});
  assert.deepEqual(operationEventForFreeEvent({type: "hull-repair-complete"}), {type: "hull-repair-complete"});
  assert.deepEqual(operationEventForFreeEvent({type: "engine-flooded"}), {type: "engine-flooded"});
  assert.deepEqual(operationEventForFreeEvent({type: "engine-water-restart"}), {type: "engine-water-restart"});
  assert.deepEqual(operationEventForFreeEvent({type: "flood-emergency-start", cause: "wrecked"}), {type: "flood-emergency-start", cause: "wrecked"});
});

test("ramming uses the established collision sound path", () => {
  assert.deepEqual(operationEventForFreeEvent({type: "ram", strength: 6}), {
    type: "collision",
    severity: 6,
    impactSpeed: 6,
    hardImpact: true,
    shore: false,
    scrape: false,
    damage: 0,
    absorbed: 0,
    pan: 0,
  });
});

test("shore impacts keep the operation shoreline branch", () => {
  assert.deepEqual(operationEventForFreeEvent({type: "collision", strength: 7, shore: true, damage: 12, pan: -0.3}), {
    type: "collision",
    severity: 7,
    impactSpeed: 7,
    hardImpact: true,
    shore: true,
    scrape: false,
    damage: 12,
    absorbed: 0,
    pan: -0.3,
  });
});
