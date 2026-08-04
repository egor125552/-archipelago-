import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LEAD_DISTANCE,
  leadTargetPointV36,
  predictHeavyPositionV36,
} from "../src/free-roam-mega-bomb-v36.js";

test("ordinary combat movement does not receive speculative mega-bomb lead", () => {
  const world = {freeHeavyAiControllerV1: {heavy: {phase: "combat"}}};
  const boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: 202,
    y: 200,
    heading: -58.56,
    speed: 18.5,
  };
  const lead = leadTargetPointV36(world, {x: 251, y: 287}, boat, 50);
  assert.equal(lead.leadDistance, 0);
  assert.equal(lead.x, boat.x);
  assert.equal(lead.y, boat.y);
});

test("unified repair escape prediction follows the real turn toward its destination", () => {
  const world = {
    freeHeavyAiControllerV1: {
      heavy: {
        phase: "escape",
        escapeReason: "repair",
        repairSystem: "turret",
        destination: {x: 32, y: 112},
      },
    },
  };
  const boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: 50,
    y: 140,
    heading: -90,
    speed: 12.2,
  };
  const lead = leadTargetPointV36(world, {x: 251, y: 287}, boat, 50);
  assert.ok(lead.x < boat.x);
  assert.ok(lead.y < boat.y);
  assert.ok(lead.leadDistance > 1);
  assert.ok(lead.leadDistance <= MAX_LEAD_DISTANCE + 0.001);
});

test("a repair-stopped heavy is not given fake movement lead", () => {
  const world = {freeHeavyAiControllerV1: {heavy: {phase: "repairing", repairSystem: "turret"}}};
  const boat = {id: "heavy-pursuer", role: "heavy", x: 80, y: 120, heading: 90, speed: 12.2};
  const predicted = predictHeavyPositionV36(world, boat, 4);
  assert.deepEqual(predicted, {x: 80, y: 120});
});

test("deleted V164 retreating phase is never predicted by V36", () => {
  const world = {
    freeCombatAiV164: {
      heavy: {
        phase: "retreating",
        destination: {x: 32, y: 112},
      },
    },
  };
  const boat = {id: "heavy-pursuer", role: "heavy", x: 50, y: 140, heading: -90, speed: 12.2};
  assert.deepEqual(predictHeavyPositionV36(world, boat, 3), {x: 50, y: 140});
});
