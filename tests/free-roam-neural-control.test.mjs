import assert from "node:assert/strict";
import test from "node:test";

import {
  applyServerFreeInput,
  consumeCompletedTrainingEpisodes,
  createServerFreeRoom,
  finishServerTrainingBattle,
  serializeTrainingEpisode,
  setServerFreePresence,
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
    startServerTrainingBattle(
      server,
      controlEnabled ? {level: 3, neuralOnly: true} : 3,
      false,
      startedAt + 40,
    );
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

test("neural control remains disabled in an ordinary quick threat", () => {
  const server = run(false);
  const status = trainingRuntimeStatus(server);
  assert.equal(status.neuralOnly, false);
  assert.equal(status.neuralShadow.controlEnabled, false);
  for (const [, x, y] of actorPositions(server.world)) {
    assert.equal(Number.isFinite(x), true);
    assert.equal(Number.isFinite(y), true);
  }
});

test("neural-only request changes tactics without leaving world bounds", () => {
  const legacy = run(false);
  const neural = run(true);
  const status = trainingRuntimeStatus(neural);
  assert.equal(status.neuralOnly, true);
  assert.equal(status.neuralShadow.controlEnabled, true);
  assert.ok(status.neuralShadow.actorCount > 0);
  assert.notDeepEqual(actorPositions(neural.world), actorPositions(legacy.world));
  for (const [, x, y] of actorPositions(neural.world)) {
    assert.ok(x >= -1 && x <= 421, `x ${x} outside world`);
    assert.ok(y >= -1 && y <= 321, `y ${y} outside world`);
  }
});

test("finishing a neural-only threat restores the ordinary world and disables control", () => {
  const server = run(true);
  const status = finishServerTrainingBattle(server, "manual", {restore: true, now: 8_000});
  assert.equal(status.trainingActive, false);
  assert.equal(status.battleActive, false);
  assert.equal(status.neuralOnly, false);
  assert.equal(status.neuralShadow.controlEnabled, false);
});

test("recorded neural battle frames include decisions, confidence, fire and guardrail diagnostics", () => {
  const startedAt = 20_000;
  const server = createServerFreeRoom(startedAt);
  setServerFreePresence(server, "captain", true);
  startServerTrainingBattle(server, {level: 5, neuralOnly: true}, true, startedAt + 40);
  for (let index = 1; index <= 60; index += 1) {
    applyServerFreeInput(server, "captain", {up: true, attack: true}, index);
    tickServerFreeRoom(server, startedAt + 40 + index * 40);
  }
  finishServerTrainingBattle(server, "test", {restore: true, now: startedAt + 3_000});
  const [episode] = consumeCompletedTrainingEpisodes(server);
  assert.ok(episode);
  const diagnosticFrames = episode.frames.filter(frame => frame.neural);
  assert.ok(diagnosticFrames.length > 0);
  const diagnostic = diagnosticFrames.at(-1).neural;
  assert.equal(diagnostic.controlEnabled, 1);
  assert.ok(Array.isArray(diagnostic.decisions));
  assert.ok(diagnostic.decisions.length > 0);
  assert.ok(Array.isArray(diagnostic.decisionSchema));
  assert.equal(typeof diagnostic.guardrails.waterGuardInterventions, "number");
  const jsonl = serializeTrainingEpisode(episode);
  assert.match(jsonl, /"decisionSchema"/);
  assert.match(jsonl, /"fireProbability"/);
  assert.match(jsonl, /"guardrails"/);
});