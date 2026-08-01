import assert from "node:assert/strict";
import test from "node:test";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  setServerNeuralControlForTest,
  startServerTrainingBattle,
  tickServerFreeRoom,
  trainingRuntimeStatus,
} from "../src/free-roam-server.js";

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function run(controlEnabled) {
  const previousRandom = Math.random;
  Math.random = seededRandom(125552);
  try {
    const startedAt = 1_000;
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    startServerTrainingBattle(server, 3, false, startedAt + 40);
    if (controlEnabled) setServerNeuralControlForTest(server, true);
    for (let index = 1; index <= 100; index += 1) {
      applyServerFreeInput(server, "captain", {up: true, right: index % 50 < 25, left: index % 50 >= 25}, index);
      tickServerFreeRoom(server, startedAt + 40 + index * 40);
    }
    return server;
  } finally {
    Math.random = previousRandom;
  }
}

function actorPositions(world) {
  return [
    world.freeActivities?.marauder,
    ...(world.freePursuerSquad?.escorts || []),
    ...(world.freeEnemyBoats?.boats || []),
    world.freeHeavyPursuer?.boat,
    ...(world.freeHostileGunners?.gunners || []),
    ...(world.freeHostileActors?.actors || []),
  ].filter(Boolean).map(entity => [entity.id || "unknown", Number(entity.x), Number(entity.y)]);
}

test("neural control remains disabled by default", () => {
  const server = run(false);
  assert.equal(trainingRuntimeStatus(server).neuralShadow.controlEnabled, false);
  for (const [, x, y] of actorPositions(server.world)) {
    assert.equal(Number.isFinite(x), true);
    assert.equal(Number.isFinite(y), true);
  }
});

test("test-only neural control changes tactics without leaving world bounds", () => {
  const legacy = run(false);
  const neural = run(true);
  const status = trainingRuntimeStatus(neural).neuralShadow;
  assert.equal(status.controlEnabled, true);
  assert.ok(status.actorCount > 0);
  assert.notDeepEqual(actorPositions(neural.world), actorPositions(legacy.world));
  for (const [, x, y] of actorPositions(neural.world)) {
    assert.ok(x >= -1 && x <= 421, `x ${x} outside world`);
    assert.ok(y >= -1 && y <= 321, `y ${y} outside world`);
  }
});
