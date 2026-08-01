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
  ensureMegaBombState,
  launchMegaBomb,
  reportMegaBombStatus,
  stepMegaBombs,
} from "./free-roam-mega-bomb.js";

export const FREE_TICK_MS = 40;
const MAX_ELAPSED_SECONDS = 0.2;
const MAX_STEP_SECONDS = 0.05;
const INPUT_KEYS = Object.freeze([
  "up", "down", "left", "right", "run", "pump", "repair", "action",
  "jump", "attack", "weapon", "sonar", "guide", "megaBomb",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
]);
const PULSE_INPUT_KEYS = Object.freeze([
  "action", "jump", "weapon", "sonar", "guide", "megaBomb",
  "shopPrevious", "shopNext", "shopBuy", "shopClose",
  "boardPrevious", "boardNext", "boardAccept", "boardClose",
]);

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

function launchPendingMegaBombs(serverRoom) {
  ensureInputBuffers(serverRoom);
  for (let index = 0; index < serverRoom.world.players.length; index += 1) {
    if (serverRoom.pendingPulses[index]?.megaBomb) launchMegaBomb(serverRoom.world, index);
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
  ensureMegaBombState(world);
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
  ensureMegaBombState(serverRoom.world);
  ensureInputBuffers(serverRoom);
  serverRoom.inputSequence[playerIndex] = 0;
  serverRoom.receivedInputs[playerIndex] = normalizeInput({});
  serverRoom.pendingPulses[playerIndex] = {};
  setPlayerPresence(serverRoom.world, playerIndex, present);
  setPlayerInput(serverRoom.world, playerIndex, withoutPulseInputs(serverRoom.receivedInputs[playerIndex]));
  if (present) reportMegaBombStatus(serverRoom.world, playerIndex);
  return true;
}

export function applyServerFreeInput(serverRoom, role, input, rawSequence) {
  const playerIndex = freePlayerIndex(role);
  if (!serverRoom?.world || playerIndex < 0) return false;
  ensureMegaBombState(serverRoom.world);
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
  // Continuous controls apply immediately. One-shot commands are held in a
  // server-side latch until an authoritative tick consumes them, so a quick
  // true/false pair cannot disappear during Worker cold start or event-loop load.
  setPlayerInput(serverRoom.world, playerIndex, withoutPulseInputs(normalized));
  return true;
}

function stepInChunks(world, elapsedSeconds) {
  let remaining = Math.min(MAX_ELAPSED_SECONDS, Math.max(0, Number(elapsedSeconds) || 0));
  while (remaining > 0.0001) {
    const chunk = Math.min(MAX_STEP_SECONDS, remaining);
    // The first pass snapshots roof exposure before projectiles move. The
    // second pass reacts to the authoritative results of this exact tick.
    applyAuthoritativeCombatHotfix(world, 0);
    stepFreeWorld(world, chunk);
    stepMegaBombs(world, chunk);
    applyAuthoritativeCombatHotfix(world, chunk);
    remaining -= chunk;
  }
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
  ensureMegaBombState(serverRoom.world);
  const elapsedSeconds = Math.max(0, (now - serverRoom.lastTickAt) / 1_000);
  serverRoom.lastTickAt = now;
  if (elapsedSeconds > 0.0001) {
    deliverPendingPulses(serverRoom);
    launchPendingMegaBombs(serverRoom);
    stepInChunks(serverRoom.world, elapsedSeconds);
    clearDeliveredPulses(serverRoom);
  }
  const events = drainEvents(serverRoom.world);
  return snapshotServerFreeRoom(serverRoom, now, events);
}
