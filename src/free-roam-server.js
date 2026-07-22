"use strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";

export const FREE_TICK_MS = 40;
const MAX_ELAPSED_SECONDS = 0.2;
const MAX_STEP_SECONDS = 0.05;
const INPUT_KEYS = Object.freeze([
  "up", "down", "left", "right", "run", "pump", "repair", "action",
  "jump", "attack", "weapon", "sonar", "guide",
]);

export function freePlayerIndex(role) {
  return role === "captain" ? 0 : role === "crew" ? 1 : -1;
}

function normalizeInput(input) {
  const result = {};
  for (const key of INPUT_KEYS) result[key] = Boolean(input?.[key]);
  result.targetId = typeof input?.targetId === "string" ? input.targetId.slice(0, 80) : null;
  return result;
}

export function createServerFreeRoom(now = Date.now()) {
  const world = createFreeWorld();
  setPlayerPresence(world, 0, false);
  setPlayerPresence(world, 1, false);
  drainEvents(world);
  return {
    world,
    lastTickAt: now,
    sequence: 0,
    inputSequence: [0, 0],
  };
}

export function setServerFreePresence(serverRoom, role, present) {
  const playerIndex = freePlayerIndex(role);
  if (!serverRoom?.world || playerIndex < 0) return false;
  serverRoom.inputSequence ||= [0, 0];
  while (serverRoom.inputSequence.length < serverRoom.world.players.length) serverRoom.inputSequence.push(0);
  if (present) {
    // Input sequence numbers are scoped to one WebSocket connection, not to
    // the lifetime of the room. A page reload creates a new JavaScript
    // context whose counter starts at one; keeping the previous connection's
    // high-water mark would reject every command until the new page caught up.
    serverRoom.inputSequence[playerIndex] = 0;
  }
  setPlayerPresence(serverRoom.world, playerIndex, present);
  if (!present) setPlayerInput(serverRoom.world, playerIndex, {});
  return true;
}

export function applyServerFreeInput(serverRoom, role, input, rawSequence) {
  const playerIndex = freePlayerIndex(role);
  if (!serverRoom?.world || playerIndex < 0) return false;
  const sequence = Math.max(0, Math.floor(Number(rawSequence) || 0));
  if (sequence && sequence <= serverRoom.inputSequence[playerIndex]) return false;
  if (sequence) serverRoom.inputSequence[playerIndex] = sequence;
  setPlayerPresence(serverRoom.world, playerIndex, true);
  setPlayerInput(serverRoom.world, playerIndex, normalizeInput(input));
  return true;
}

function stepInChunks(world, elapsedSeconds) {
  let remaining = Math.min(MAX_ELAPSED_SECONDS, Math.max(0, Number(elapsedSeconds) || 0));
  while (remaining > 0.0001) {
    const chunk = Math.min(MAX_STEP_SECONDS, remaining);
    stepFreeWorld(world, chunk);
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
  const elapsedSeconds = Math.max(0, (now - serverRoom.lastTickAt) / 1_000);
  serverRoom.lastTickAt = now;
  stepInChunks(serverRoom.world, elapsedSeconds);
  const events = drainEvents(serverRoom.world);
  return snapshotServerFreeRoom(serverRoom, now, events);
}
