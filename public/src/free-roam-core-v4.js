"use strict";

import * as base from "./free-roam-core-v3.js?v=35";
import {operationSteeringDelta, shouldCenterRudder} from "./free-roam-steering-model.js";

export const WORLD = base.WORLD;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function ensureState(world) {
  world.steeringPrevious ||= Array.from({length: world.players?.length || 2}, () => 0);
  while (world.steeringPrevious.length < world.players.length) world.steeringPrevious.push(0);
  return world;
}

function placePlayersTogether(world) {
  const positions = [
    {x: 199, y: 158, heading: 0},
    {x: 219, y: 158, heading: 0},
  ];
  for (let index = 0; index < Math.min(world.boats.length, positions.length); index += 1) {
    const boat = world.boats[index];
    const position = positions[index];
    boat.x = position.x;
    boat.y = position.y;
    boat.heading = position.heading;
    boat.speed = 0;
    boat.throttle = 0;
    boat.rudder = 0;
    const player = world.players[index];
    if (player) {
      player.mode = "boat";
      player.activeBoat = boat.id;
      player.x = boat.x;
      player.y = boat.y;
      player.heading = boat.heading;
    }
  }
  return world;
}

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
}

export function createFreeWorld() {
  return placePlayersTogether(ensureState(base.createFreeWorld()));
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
    const manualSteer = Number(Boolean(input.right)) - Number(Boolean(input.left));
    const guideSteer = manualSteer ? 0 : clamp(Number(boat.sonarGuideSteer) || 0, -0.28, 0.28);
    const steer = manualSteer || guideSteer;
    const previousSteer = world.steeringPrevious[playerIndex] || 0;

    if (shouldCenterRudder(steer)) {
      boat.rudder = 0;
    } else {
      boat.heading = wrapDeg(boat.heading + operationSteeringDelta(boat.speed, steer, safeDt));
    }

    if (manualSteer !== previousSteer) {
      if (manualSteer) {
        emit(world, "turn", "", [playerIndex], {
          direction: manualSteer < 0 ? "left" : "right",
          pan: manualSteer < 0 ? -0.88 : 0.88,
        });
      } else if (previousSteer) {
        emit(world, "turn-complete", "", [playerIndex], {
          heading: boat.heading,
          pan: previousSteer < 0 ? -0.5 : 0.5,
        });
      }
      world.steeringPrevious[playerIndex] = manualSteer;
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
