import assert from "node:assert/strict";
import test from "node:test";

import {
  createServerFreeRoom,
  neuralV2OverrideStatus,
  setServerFreePresence,
  setServerNeuralV2Override,
  startServerTrainingBattle,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {collectNeuralActors} from "../src/free-roam-neural-shadow.js";

test("removing one v2 action keeps its authoritative diagnostics for scoring", () => {
  const startedAt = 30_000;
  const server = createServerFreeRoom(startedAt);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level: 3, neuralOnly: true}, false, startedAt + 40);
  tickServerFreeRoom(server, startedAt + 80);
  const actor = collectNeuralActors(server.world).find(item => item.kind === "boat" && item.controlsMovement !== false);
  assert.ok(actor);

  setServerNeuralV2Override(server, actor.id, {
    throttle: "full",
    steering: "right",
    range: "far",
    route: "safe_water",
    fire: false,
  });
  for (let step = 2; step <= 12; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const during = neuralV2OverrideStatus(server);
  assert.equal(during.enabled, true);
  assert.ok(during.diagnostics.controlledFrames > 0);

  setServerNeuralV2Override(server, actor.id, null);
  const after = neuralV2OverrideStatus(server);
  assert.equal(after.enabled, false);
  assert.equal(after.actionCount, 0);
  assert.equal(after.diagnostics.controlledFrames, during.diagnostics.controlledFrames);
  assert.equal(Number.isFinite(after.diagnostics.waterGuardInterventions), true);
});
