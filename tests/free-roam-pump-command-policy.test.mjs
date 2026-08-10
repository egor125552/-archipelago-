import test from "node:test";
import assert from "node:assert/strict";

import {
  pumpCommandContext,
  pumpFeedbackDecision,
  vesselScopedPumpShouldReset,
} from "../public/src/free-roam-pump-command-policy-v1.js?v=1";

function worldWithPump({
  activeBoat = 4,
  sunk = false,
  health = 100,
  enabled = true,
  repairActive = false,
  pumpActive = false,
  modular = true,
} = {}) {
  const boat = {
    id: 4,
    sunk,
    pumpActive,
    vesselRuntimeState: modular ? {
      staticModules: {
        "bilge-pump": {health, enabled, repairActive},
      },
    } : undefined,
  };
  return {
    players: [{activeBoat}],
    boats: [null, null, null, null, boat],
  };
}

test("a destroyed modular pump rejects the command instead of claiming it started", () => {
  const world = worldWithPump({health: 0, enabled: false});
  const context = pumpCommandContext(world, 0);
  assert.equal(context.state, "blocked");
  assert.equal(context.reason, "damaged");
  assert.match(context.text, /Насос включить невозможно/i);

  const feedback = pumpFeedbackDecision("Насос включён.", world, 0);
  assert.equal(feedback.mode, "replace");
  assert.match(feedback.text, /трюмная помпа повреждена/i);
});

test("a healthy modular pump request stays silent until authoritative pumpActive confirmation", () => {
  const world = worldWithPump({health: 65, enabled: true, pumpActive: false});
  assert.equal(pumpCommandContext(world, 0).state, "pending");
  assert.equal(pumpFeedbackDecision("Насос включён.", world, 0).mode, "suppress");

  world.boats[4].pumpActive = true;
  assert.equal(pumpCommandContext(world, 0).state, "active");
  const confirmed = pumpFeedbackDecision("Насос включён.", world, 0);
  assert.equal(confirmed.mode, "pass");
  assert.equal(confirmed.text, "Насос включён.");
});

test("pump cannot be switched on after the vessel has sunk and released the player", () => {
  const world = worldWithPump({activeBoat: null, sunk: true, health: 0, enabled: false});
  const context = pumpCommandContext(world, 0, {recentBoatId: 4});
  assert.equal(context.state, "blocked");
  assert.equal(context.reason, "sunk");
  assert.match(context.text, /судно затонуло/i);
});

test("pump command is vessel-scoped and resets when the player changes vessels", () => {
  assert.equal(vesselScopedPumpShouldReset(3, 4, true), true);
  assert.equal(vesselScopedPumpShouldReset(4, null, true), true);
  assert.equal(vesselScopedPumpShouldReset(4, 4, true), false);
  assert.equal(vesselScopedPumpShouldReset(3, 4, false), false);
});

test("legacy pump keeps its existing immediate control contract", () => {
  const world = worldWithPump({modular: false});
  assert.equal(pumpCommandContext(world, 0).state, "legacy");
  assert.equal(pumpFeedbackDecision("Насос включён.", world, 0).mode, "pass");
});
