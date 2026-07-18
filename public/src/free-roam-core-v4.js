"use strict";

import * as base from "./free-roam-core-v3.js";

export const WORLD = base.WORLD;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function ensureState(world) {
  world.steeringPrevious ||= Array.from({length: world.players?.length || 2}, () => 0);
  while (world.steeringPrevious.length < world.players.length) world.steeringPrevious.push(0);
  return world;
}

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
}

export function createFreeWorld() {
  return ensureState(base.createFreeWorld());
}

export function setPlayerInput(world, playerIndex, input) {
  ensureState(world);
  base.setPlayerInput(world, playerIndex, input);
}

export const drainEvents = base.drainEvents;

function applyOperationSteering(world, safeDt) {
  for (let playerIndex = 0; playerIndex < world.players.length; playerIndex += 1) {
    const player = world.players[playerIndex];
    if (player?.mode !== "boat") continue;
    const boat = world.boats[player.activeBoat];
    if (!boat || boat.sunk) continue;
    const input = world.operationInputs?.[playerIndex] || world.inputs?.[playerIndex] || {};
    const steer = Number(Boolean(input.right)) - Number(Boolean(input.left));
    const previousSteer = world.steeringPrevious[playerIndex] || 0;

    if (!steer) {
      // The operation controller drops residual rudder immediately when the
      // wheel is released. Free roam used to keep turning for several frames.
      boat.rudder = 0;
    } else {
      const direction = Math.sign(boat.speed || 1);
      const accessibleFactor = clamp(Math.abs(boat.speed) / 4.5, 0.45, 1.35);
      const detailedFactor = clamp(Math.abs(boat.speed) / 4, 0.55, 1.3);
      const extraAuthority = 0.31 * accessibleFactor + 0.13 * detailedFactor;
      boat.heading = wrapDeg(boat.heading + steer * extraAuthority * safeDt * 60 * direction);
    }

    if (steer !== previousSteer) {
      if (steer) {
        emit(world, "turn", "", [playerIndex], {
          direction: steer < 0 ? "left" : "right",
          pan: steer < 0 ? -0.88 : 0.88,
        });
      } else if (previousSteer) {
        emit(world, "turn-complete", "", [playerIndex], {
          heading: boat.heading,
          pan: previousSteer < 0 ? -0.5 : 0.5,
        });
      }
      world.steeringPrevious[playerIndex] = steer;
    }
  }
}

function enrichMovementEvents(world, eventStart) {
  const fresh = world.events.slice(eventStart);
  for (const event of fresh) {
    if (!event || !["footstep", "swim-step"].includes(event.type)) continue;
    const sourcePlayer = Number(event.targets?.[0]);
    const player = world.players[sourcePlayer];
    if (!player) continue;
    const input = world.operationInputs?.[sourcePlayer] || world.inputs?.[sourcePlayer] || {};
    event.targets = world.players.map((_, index) => index);
    event.sourcePlayer = sourcePlayer;
    event.x = Number(player.x) || 0;
    event.y = Number(player.y) || 0;
    event.heading = Number(player.heading) || 0;
    event.movementPan = clamp(Number(Boolean(input.right)) - Number(Boolean(input.left)), -1, 1);
  }
}

export function stepFreeWorld(world, dt) {
  ensureState(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  const eventStart = world.events?.length || 0;
  base.stepFreeWorld(world, safeDt);
  applyOperationSteering(world, safeDt);
  enrichMovementEvents(world, eventStart);
  return world;
}

export function playerStatus(world, playerIndex) {
  ensureState(world);
  return base.playerStatus(world, playerIndex);
}

export function snapshotWorld(world) {
  ensureState(world);
  return base.snapshotWorld(world);
}
