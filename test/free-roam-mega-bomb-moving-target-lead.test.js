import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LEAD_DISTANCE,
  leadTargetPointV36,
  predictHeavyPositionV36,
} from "../src/free-roam-mega-bomb-v36.js";

test("a fast straight-moving heavy receives physical launch lead", () => {
  const world = {freeCombatAiV164: {heavy: {phase: "combat"}}};
  const boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: 202,
    y: 200,
    heading: -58.56,
    speed: 18.5,
  };
  const lead = leadTargetPointV36(world, {x: 251, y: 287}, boat, 50);
  assert.ok(lead.x < boat.x - 20);
  assert.ok(lead.y < boat.y - 10);
  assert.ok(lead.leadDistance <= MAX_LEAD_DISTANCE + 0.001);
});

test("repair escape prediction follows the real turn toward the stable destination", () => {
  const world = {
    freeCombatAiV164: {
      heavy: {
        phase: "breach-escaping-v166",
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
  const predicted = predictHeavyPositionV36(world, boat, 2);
  assert.ok(predicted.x < boat.x);
  assert.ok(predicted.y < boat.y);
});

test("a repair-stopped heavy is not given fake movement lead", () => {
  const world = {freeCombatAiV164: {heavy: {phase: "breach-repairing-v166"}}};
  const boat = {id: "heavy-pursuer", role: "heavy", x: 80, y: 120, heading: 90, speed: 12.2};
  const predicted = predictHeavyPositionV36(world, boat, 4);
  assert.deepEqual(predicted, {x: 80, y: 120});
});
