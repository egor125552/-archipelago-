"use strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {applyCombatDamage} from "../public/src/free-roam-combat-v2.js?v=5";
import {applyCombatAiHotfixV163} from "../public/src/free-roam-combat-ai-hotfix-v163.js?v=1";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";
import {reserveUnconnectedBoats} from "../public/src/free-roam-reserve-boats.js";
import {
  finishServerNeuralControl,
  neuralControlDiagnostics,
  prepareServerNeuralControl,
} from "./free-roam-neural-control.js";
import {
  clearServerNeuralShadow,
  neuralDecisionSnapshot,
  neuralShadowStatus,
  setServerNeuralControlForTest,
  updateServerNeuralShadow,
} from "./free-roam-neural-shadow.js";
import {
  clearServerNeuralV2Overrides,
  finishServerNeuralV2Overrides,
  neuralV2OverrideStatus,
  prepareServerNeuralV2Overrides,
  setServerNeuralV2Override,
} from "./free-roam-neural-v2-overrides.js";
import {
  consumeCompletedTrainingEpisodes,
  finishServerTrainingBattle as finishServerTrainingBattleBase,
  persistedWorldForServerRoom,
  serializeTrainingEpisode,
  setServerTrainingRecording,
  startServerTrainingBattle as startServerTrainingBattleBase,
  trainingRuntimeStatus as trainingRuntimeStatusBase,
  updateTrainingRecorder,
} from "./free-roam-training.js";

export const FREE_TICK_MS = 40;
const MAX_ELAPSED_SECONDS = 0.2;
const MAX_STEP_SECONDS = 0.05;
const TRAINING_CREDIT_FLOOR = 180;
const INPUT_KEYS = Object.freeze([
  "up", "down", "left", "right", "run", "pump", "repair", "action",
  "jump", "attack", "weapon", "sonar", "guide",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
]);
const PULSE_INPUT_KEYS = Object.freeze([
  "action", "jump", "weapon", "sonar", "guide",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
]);

const round = (value, digits = 4) => {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
};

export function freePlayerIndex(role) {
  return role === "captain" ? 0 : role === "crew" ? 1 : -1;
}

function normalizeInput(input) {
  const result = {};
  for (const key of INPUT_KEYS) result[key] = Boolean(input?.[key]);
  result.targetId = typeof input?.targetId === "string" ? input.targetId.slice(0, 80) : null;
  result.navigationTargetId = ["objective", "merchant", "board"].includes(input?.navigationTargetId)
    ? input.navigationTargetId
    : "objective";
  return result;
}

function withoutPulseInputs(input) {
  const result = {...normalizeInput(input)};
  for (const key of PULSE_INPUT_KEYS) result[key] = false;
  return result;
}

function ensureInputBuffers(serverRoom) {
  const playerCount = serverRoom?.world?.players?.length || 2;
  serverRoom.inputSequence ||= [];
  serverRoom.receivedInputs ||= [];
  serverRoom.pendingPulses ||= [];
  while (serverRoom.inputSequence.length < playerCount) serverRoom.inputSequence.push(0);
  while (serverRoom.receivedInputs.length < playerCount) serverRoom.receivedInputs.push(normalizeInput({}));
  while (serverRoom.pendingPulses.length < playerCount) serverRoom.pendingPulses.push({});
}

function bufferedInput(serverRoom, playerIndex) {
  const result = withoutPulseInputs(serverRoom.receivedInputs[playerIndex]);
  const pending = serverRoom.pendingPulses[playerIndex] || {};
  for (const key of PULSE_INPUT_KEYS) {
    if (pending[key]) result[key] = true;
  }
  return result;
}

function deliverPendingPulses(serverRoom) {
  ensureInputBuffers(serverRoom);
  for (let index = 0; index < serverRoom.world.players.length; index += 1) {
    setPlayerInput(serverRoom.world, index, bufferedInput(serverRoom, index));
  }
}

function clearDeliveredPulses(serverRoom) {
  ensureInputBuffers(serverRoom);
  for (let index = 0; index < serverRoom.world.players.length; index += 1) {
    serverRoom.pendingPulses[index] = {};
    setPlayerInput(serverRoom.world, index, withoutPulseInputs(serverRoom.receivedInputs[index]));
  }
}

function applyAuthoritativeCombatHotfix(world, dt) {
  applyCombatAiHotfixV163(world, dt, {
    damagePlayer(targetWorld, targetIndex, amount, details) {
      return applyCombatDamage(targetWorld, targetIndex, amount, -1, details, {});
    },
  });
}

export function createServerFreeRoom(now = Date.now()) {
  const world = createFreeWorld();
  setPlayerPresence(world, 0, false);
  setPlayerPresence(world, 1, false);
  reserveUnconnectedBoats(world);
  drainEvents(world);
  const playerCount = world.players.length;
  return {
    world,
    lastTickAt: now,
    sequence: 0,
    inputSequence: Array.from({length: playerCount}, () => 0),
    receivedInputs: Array.from({length: playerCount}, () => normalizeInput({})),
    pendingPulses: Array.from({length: playerCount}, () => ({})),
  };
}

export function setServerFreePresence(serverRoom, role, present) {
  const playerIndex = freePlayerIndex(role);
  if (!serverRoom?.world || playerIndex < 0) return false;
  ensureInputBuffers(serverRoom);
  serverRoom.inputSequence[playerIndex] = 0;
  serverRoom.receivedInputs[playerIndex] = normalizeInput({});
  serverRoom.pendingPulses[playerIndex] = {};
  setPlayerPresence(serverRoom.world, playerIndex, present);
  setPlayerInput(serverRoom.world, playerIndex, withoutPulseInputs(serverRoom.receivedInputs[playerIndex]));
  return true;
}

export function applyServerFreeInput(serverRoom, role, input, rawSequence) {
  const playerIndex = freePlayerIndex(role);
  if (!serverRoom?.world || playerIndex < 0) return false;
  ensureInputBuffers(serverRoom);
  const sequence = Math.max(0, Math.floor(Number(rawSequence) || 0));
  if (sequence && sequence <= serverRoom.inputSequence[playerIndex]) return false;
  if (sequence) serverRoom.inputSequence[playerIndex] = sequence;

  const normalized = normalizeInput(input);
  const previous = serverRoom.receivedInputs[playerIndex] || normalizeInput({});
  const pending = serverRoom.pendingPulses[playerIndex] || (serverRoom.pendingPulses[playerIndex] = {});
  for (const key of PULSE_INPUT_KEYS) {
    if (normalized[key] && !previous[key]) pending[key] = true;
  }
  serverRoom.receivedInputs[playerIndex] = normalized;

  setPlayerPresence(serverRoom.world, playerIndex, true);
  setPlayerInput(serverRoom.world, playerIndex, withoutPulseInputs(normalized));
  return true;
}

function stepInChunks(serverRoom, elapsedSeconds) {
  const world = serverRoom.world;
  let remaining = Math.min(MAX_ELAPSED_SECONDS, Math.max(0, Number(elapsedSeconds) || 0));
  while (remaining > 0.0001) {
    const chunk = Math.min(MAX_STEP_SECONDS, remaining);
    applyAuthoritativeCombatHotfix(world, 0);
    const neuralFrames = prepareServerNeuralControl(serverRoom);
    const neuralV2Frames = prepareServerNeuralV2Overrides(serverRoom);
    stepFreeWorld(world, chunk);
    applyAuthoritativeCombatHotfix(world, chunk);
    finishServerNeuralControl(serverRoom, neuralFrames, chunk);
    finishServerNeuralV2Overrides(serverRoom, neuralV2Frames, chunk);
    remaining -= chunk;
  }
}

function attachTrainingNeuralDiagnostics(serverRoom) {
  const episode = serverRoom?.trainingRuntime?.episode;
  const frame = episode?.frames?.at(-1);
  if (!frame || frame.neural) return;
  const shadow = neuralShadowStatus(serverRoom);
  const decisions = neuralDecisionSnapshot(serverRoom).map(decision => [
    decision.id,
    decision.role,
    decision.kind,
    Number(decision.movementIndex) || 0,
    round(decision.confidence),
    decision.fire ? 1 : 0,
    decision.rawFire ? 1 : 0,
    round(decision.fireProbability),
    round(decision.fireThreshold),
    Number(decision.fireLatch) || 0,
    decision.forcedExploration ? 1 : 0,
    decision.controlsMovement === false ? 0 : 1,
    decision.controlsFire === false ? 0 : 1,
  ]);
  frame.neural = {
    model: [shadow.modelFormat || null, shadow.modelVersion || null],
    controlEnabled: shadow.controlEnabled ? 1 : 0,
    meanMovementConfidence: round(shadow.meanMovementConfidence),
    meanFireProbability: round(shadow.meanFireProbability),
    lowConfidenceCount: Number(shadow.lowConfidenceCount) || 0,
    forcedExplorationCount: Number(shadow.forcedExplorationCount) || 0,
    heavyTurret: [
      shadow.heavyTurretTracked ? 1 : 0,
      shadow.heavyTurretFire ? 1 : 0,
      round(shadow.heavyTurretFireProbability),
      shadow.heavyTurretForcedExploration ? 1 : 0,
    ],
    decisions,
    guardrails: neuralControlDiagnostics(serverRoom),
    v2Override: neuralV2OverrideStatus(serverRoom),
    decisionSchema: [
      "id", "role", "kind", "movementIndex", "confidence", "fire", "rawFire",
      "fireProbability", "fireThreshold", "fireLatch", "forcedExploration",
      "controlsMovement", "controlsFire",
    ],
  };
}

export function snapshotServerFreeRoom(serverRoom, now = Date.now(), events = []) {
  serverRoom.sequence += 1;
  return {
    sequence: serverRoom.sequence,
    serverAt: now,
    ackInput: [...serverRoom.inputSequence],
    world: replicatedFreeWorld(serverRoom.world),
    events,
  };
}

export function tickServerFreeRoom(serverRoom, now = Date.now()) {
  if (!serverRoom?.world) return null;
  const elapsedSeconds = Math.max(0, (now - serverRoom.lastTickAt) / 1_000);
  serverRoom.lastTickAt = now;
  updateServerNeuralShadow(serverRoom, now);
  if (elapsedSeconds > 0.0001) {
    deliverPendingPulses(serverRoom);
    stepInChunks(serverRoom, elapsedSeconds);
    clearDeliveredPulses(serverRoom);
  }
  const events = drainEvents(serverRoom.world);
  updateTrainingRecorder(serverRoom, now, events);
  attachTrainingNeuralDiagnostics(serverRoom);
  return snapshotServerFreeRoom(serverRoom, now, events);
}

export function startServerTrainingBattle(serverRoom, requestedLevel, record = true, now = Date.now()) {
  const request = requestedLevel && typeof requestedLevel === "object"
    ? requestedLevel
    : {level: requestedLevel, neuralOnly: false};
  const level = request.level;
  const neuralOnly = request.neuralOnly === true;

  clearServerNeuralShadow(serverRoom);
  clearServerNeuralV2Overrides(serverRoom);
  startServerTrainingBattleBase(serverRoom, level, record, now);
  const activities = serverRoom?.world?.freeActivities;
  if (activities) activities.credits = Math.max(TRAINING_CREDIT_FLOOR, Number(activities.credits) || 0);
  if (neuralOnly) {
    setServerNeuralControlForTest(serverRoom, true);
    updateServerNeuralShadow(serverRoom, now);
  }
  return trainingRuntimeStatus(serverRoom);
}

export function finishServerTrainingBattle(serverRoom, outcome = "manual", options = {}) {
  finishServerTrainingBattleBase(serverRoom, outcome, options);
  clearServerNeuralShadow(serverRoom);
  clearServerNeuralV2Overrides(serverRoom);
  return trainingRuntimeStatus(serverRoom);
}

export function trainingRuntimeStatus(serverRoom) {
  const base = trainingRuntimeStatusBase(serverRoom);
  const neuralShadow = neuralShadowStatus(serverRoom);
  return {
    ...base,
    neuralOnly: Boolean(base.trainingActive && neuralShadow.controlEnabled),
    neuralShadow,
    neuralGuardrails: neuralControlDiagnostics(serverRoom),
    neuralV2Override: neuralV2OverrideStatus(serverRoom),
  };
}

export {
  clearServerNeuralV2Overrides,
  consumeCompletedTrainingEpisodes,
  neuralV2OverrideStatus,
  persistedWorldForServerRoom,
  serializeTrainingEpisode,
  setServerNeuralControlForTest,
  setServerNeuralV2Override,
  setServerTrainingRecording,
};