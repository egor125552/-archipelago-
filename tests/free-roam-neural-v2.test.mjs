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
import {neuralV2DesiredMotion, neuralV2RoutePoint} from "../src/free-roam-neural-v2-control.js";
import {neuralV2FeatureVector} from "../src/free-roam-neural-v2-features.js";
import {
  NEURAL_V2_FEATURE_NAMES,
  NEURAL_V2_INPUT_SIZE,
  normalizeNeuralV2Action,
} from "../src/free-roam-neural-v2-schema.js";

test("v2 action heads remain independent and normalized", () => {
  const action = normalizeNeuralV2Action({
    throttle: "full",
    steering: "hard_right",
    range: "far",
    route: "shore_gate",
    fire: true,
  });
  assert.equal(action.throttle, "full");
  assert.equal(action.steering, "hard_right");
  assert.equal(action.range, "far");
  assert.equal(action.route, "shore_gate");
  assert.equal(action.fire, true);
});

test("v2 boat routing can choose water safety or the shore gate explicitly", () => {
  const actor = {kind: "boat", role: "gunboat", entity: {x: 50, y: 180, heading: 0}};
  assert.deepEqual(neuralV2RoutePoint(actor, {x: 40, y: 20}, {route: "shore_gate"}), {
    x: 118,
    y: 88,
    redirected: true,
    route: "shore_gate",
  });
  assert.deepEqual(neuralV2RoutePoint(actor, {x: 500, y: 20}, {route: "safe_water"}), {
    x: 402,
    y: 90,
    redirected: true,
    route: "safe_water",
  });
});

test("v2 separates throttle, steering and preferred range", () => {
  const actor = {kind: "boat", role: "gunboat", entity: {x: 210, y: 180, heading: 0}};
  const target = {x: 210, y: 100};
  const slowLeft = neuralV2DesiredMotion(actor, target, {
    throttle: "slow",
    steering: "left",
    range: "medium",
    route: "safe_water",
    fire: false,
  });
  const fullRight = neuralV2DesiredMotion(actor, target, {
    throttle: "full",
    steering: "right",
    range: "medium",
    route: "safe_water",
    fire: true,
  });
  assert.ok(fullRight.speed > slowLeft.speed);
  assert.ok(fullRight.heading > slowLeft.heading);
  assert.equal(slowLeft.preferredRange, fullRight.preferredRange);
  assert.equal(slowLeft.fire, false);
  assert.equal(fullRight.fire, true);
});

test("v2 override controls an actor inside the authoritative 40 ms server tick", () => {
  const startedAt = 5_000;
  const server = createServerFreeRoom(startedAt);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level: 3, neuralOnly: true}, false, startedAt + 40);
  tickServerFreeRoom(server, startedAt + 80);
  const actor = collectNeuralActors(server.world).find(item => item.controlsMovement !== false && item.kind === "boat");
  assert.ok(actor);
  const before = {x: actor.entity.x, y: actor.entity.y, heading: actor.entity.heading};
  setServerNeuralV2Override(server, actor.id, {
    throttle: "full",
    steering: "hard_right",
    range: "far",
    route: "safe_water",
    fire: false,
    source: "unit-test",
  });
  for (let step = 2; step <= 30; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const status = neuralV2OverrideStatus(server);
  assert.equal(status.enabled, true);
  assert.equal(status.actionCount, 1);
  assert.ok(status.diagnostics.controlledFrames > 0);
  assert.ok(status.diagnostics.movementFrames > 0);
  assert.ok(Math.hypot(actor.entity.x - before.x, actor.entity.y - before.y) > 0.1);
  assert.notEqual(actor.entity.heading, before.heading);
});

test("v2 produces finite 53-value features for every production threat actor", () => {
  assert.equal(NEURAL_V2_INPUT_SIZE, NEURAL_V2_FEATURE_NAMES.length);
  assert.equal(NEURAL_V2_INPUT_SIZE, 53);
  const startedAt = 10_000;
  const server = createServerFreeRoom(startedAt);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level: 5, neuralOnly: true}, false, startedAt + 40);
  for (let step = 1; step <= 190; step += 1) tickServerFreeRoom(server, startedAt + 40 + step * 40);
  const actors = collectNeuralActors(server.world);
  assert.ok(actors.some(actor => actor.role === "heavy"));
  assert.ok(actors.some(actor => actor.role === "heavy_turret"));
  for (const actor of actors) {
    const features = neuralV2FeatureVector(server.world, actor, {
      stuckMs: 800,
      previousAction: {throttle: "cruise", steering: "straight", range: "medium", route: "safe_water", fire: false},
    });
    assert.equal(features.length, NEURAL_V2_INPUT_SIZE, actor.id);
    assert.ok(features.every(Number.isFinite), actor.id);
  }
});
