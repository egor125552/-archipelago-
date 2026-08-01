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

function activeActor(server, predicate) {
  return collectNeuralActors(server.world).find(predicate);
}

function createThreat(level = 4) {
  const startedAt = 80_000;
  const server = createServerFreeRoom(startedAt);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level, neuralOnly: true}, false, startedAt + 40);
  for (let step = 1; step <= 80; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  return {server, startedAt};
}

test("isolated steering changes only the movement head over v1 control", () => {
  const {server, startedAt} = createThreat(4);
  const actor = activeActor(server, item => item.controlsMovement !== false && item.kind === "boat");
  assert.ok(actor);
  setServerNeuralV2Override(server, actor.id, {
    head: "steering",
    steering: "hard_right",
    source: "isolated-test",
  });
  const beforeHeading = actor.entity.heading;
  for (let step = 81; step <= 105; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const status = neuralV2OverrideStatus(server);
  const effect = status.diagnostics.isolatedHeadEffects.steering;
  assert.equal(status.actions[0].head, "steering");
  assert.equal(status.actions[0].isolated, true);
  assert.ok(status.diagnostics.isolatedHeadFrames.steering > 0);
  assert.equal(status.diagnostics.isolatedHeadFrames.fire, 0);
  assert.equal(status.diagnostics.fireAllowedFrames, 0);
  assert.equal(status.diagnostics.fireSuppressedFrames, 0);
  assert.ok(status.diagnostics.movementFrames > 0);
  assert.ok(effect.frames > 0);
  assert.ok(effect.changedFrames > 0);
  assert.ok(effect.headingDeltaTotal > 0);
  assert.ok(effect.positionDeltaTotal > 0);
  assert.notEqual(actor.entity.heading, beforeHeading);
});

test("isolated fire permission does not replace the v1 movement controller", () => {
  const {server, startedAt} = createThreat(5);
  const actor = activeActor(server, item => item.controlsFire !== false && item.controlsMovement !== false);
  assert.ok(actor);
  setServerNeuralV2Override(server, actor.id, {
    head: "fire",
    fire: true,
    source: "isolated-test",
  });
  for (let step = 81; step <= 105; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const status = neuralV2OverrideStatus(server);
  const effect = status.diagnostics.isolatedHeadEffects.fire;
  assert.equal(status.actions[0].head, "fire");
  assert.equal(status.actions[0].isolated, true);
  assert.ok(status.diagnostics.isolatedHeadFrames.fire > 0);
  assert.equal(status.diagnostics.movementFrames, 0);
  assert.ok(status.diagnostics.fireAllowedFrames > 0);
  assert.ok(effect.frames > 0);
  assert.equal(effect.fireAllowedFrames, status.diagnostics.fireAllowedFrames);
  assert.ok(server.neuralControlRuntime?.totals?.controlled > 0);
});

test("isolated hold-fire suppresses only the selected actor fire path", () => {
  const {server, startedAt} = createThreat(5);
  const actor = activeActor(server, item => item.controlsFire !== false);
  assert.ok(actor);
  setServerNeuralV2Override(server, actor.id, {
    head: "fire",
    fire: false,
    source: "isolated-test",
  });
  for (let step = 81; step <= 95; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const status = neuralV2OverrideStatus(server);
  const effect = status.diagnostics.isolatedHeadEffects.fire;
  assert.ok(status.diagnostics.isolatedHeadFrames.fire > 0);
  assert.ok(status.diagnostics.fireSuppressedFrames > 0 || Number(actor.entity.aimRemaining) > 0 || Number(actor.entity.burstRemaining) > 0);
  assert.equal(status.diagnostics.movementFrames, 0);
  assert.ok(effect.frames > 0);
  assert.equal(effect.fireSuppressedFrames, status.diagnostics.fireSuppressedFrames);
});
