"use strict";

import {CONFIG} from "./game-core-v18.js?free=prediction";
import {WORLD} from "./free-roam-core-v6.js?v=39";
import {operationSteeringDelta} from "./free-roam-steering-model.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = degrees => degrees * Math.PI / 180;

function blendAngle(authoritative, predicted, keep) {
  const difference = wrapDeg((Number(predicted) || 0) - (Number(authoritative) || 0));
  return wrapDeg((Number(authoritative) || 0) + difference * keep);
}

export function reconcileLocalPrediction(previousWorld, nextWorld, playerIndex) {
  const previousPlayer = previousWorld?.players?.[playerIndex];
  const nextPlayer = nextWorld?.players?.[playerIndex];
  if (!previousPlayer || !nextPlayer || previousPlayer.mode !== nextPlayer.mode) return nextWorld;

  if (nextPlayer.mode === "boat" && previousPlayer.activeBoat === nextPlayer.activeBoat) {
    const previousBoat = previousWorld.boats?.[previousPlayer.activeBoat];
    const nextBoat = nextWorld.boats?.[nextPlayer.activeBoat];
    if (!previousBoat || !nextBoat || nextBoat.sunk) return nextWorld;
    const error = Math.hypot(previousBoat.x - nextBoat.x, previousBoat.y - nextBoat.y);
    if (error > 10) return nextWorld;
    const keep = 0.72;
    nextBoat.x += (previousBoat.x - nextBoat.x) * keep;
    nextBoat.y += (previousBoat.y - nextBoat.y) * keep;
    nextBoat.heading = blendAngle(nextBoat.heading, previousBoat.heading, keep);
    nextBoat.speed += (previousBoat.speed - nextBoat.speed) * keep;
    nextBoat.throttle += (previousBoat.throttle - nextBoat.throttle) * keep;
    nextPlayer.x = nextBoat.x;
    nextPlayer.y = nextBoat.y;
    nextPlayer.heading = nextBoat.heading;
    return nextWorld;
  }

  if (["foot", "swim"].includes(nextPlayer.mode)) {
    const error = Math.hypot(previousPlayer.x - nextPlayer.x, previousPlayer.y - nextPlayer.y);
    if (error > 7) return nextWorld;
    const keep = 0.68;
    nextPlayer.x += (previousPlayer.x - nextPlayer.x) * keep;
    nextPlayer.y += (previousPlayer.y - nextPlayer.y) * keep;
    nextPlayer.heading = blendAngle(nextPlayer.heading, previousPlayer.heading, keep);
  }
  return nextWorld;
}

function predictBoat(world, playerIndex, input, dt) {
  const player = world.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (!boat || boat.sunk || boat.driver !== playerIndex) return;
  const steer = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const thrust = Number(Boolean(input.up)) - Number(Boolean(input.down));
  if (thrust) {
    boat.throttle += (thrust - (Number(boat.throttle) || 0)) * Math.min(1, dt * 4.5);
  } else {
    // The authoritative free-roam model deliberately preserves physical
    // coast after releasing the engine. Predict the same behaviour so a
    // local release never looks like an invented brake.
    boat.throttle = 0;
  }
  if (boat.engineStalled || boat.emergencyActive) boat.throttle = 0;
  if (!thrust && !boat.engineStalled && !boat.emergencyActive) {
    boat.speed *= Math.exp(-0.028 * dt);
  } else {
    const targetSpeed = boat.throttle >= 0
      ? boat.throttle * CONFIG.maxSpeed
      : boat.throttle * Math.abs(CONFIG.reverseSpeed);
    boat.speed += clamp(targetSpeed - boat.speed, -CONFIG.acceleration * dt, CONFIG.acceleration * dt);
    boat.speed *= Math.max(0, 1 - CONFIG.drag * dt * (0.12 + Math.abs(boat.speed) / CONFIG.maxSpeed * 0.16));
  }
  if (steer) boat.heading = wrapDeg(boat.heading + operationSteeringDelta(boat.speed, steer, dt));
  boat.x = clamp(boat.x + Math.sin(rad(boat.heading)) * boat.speed * dt, WORLD.boatRadius, WORLD.width - WORLD.boatRadius);
  boat.y = clamp(boat.y - Math.cos(rad(boat.heading)) * boat.speed * dt, WORLD.shoreY + 4, WORLD.height - WORLD.boatRadius);
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}

function predictPerson(world, playerIndex, input, dt) {
  const player = world.players?.[playerIndex];
  if (!player || !["foot", "swim"].includes(player.mode) || player.combat?.knockedDown) return;
  let dx = Number(Boolean(input.right)) - Number(Boolean(input.left));
  let dy = Number(Boolean(input.down)) - Number(Boolean(input.up));
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  dx /= length;
  dy /= length;
  const speed = player.mode === "swim" ? 6 : input.run ? 13.76 : 8;
  player.x = clamp(player.x + dx * speed * dt, 5, WORLD.width - 5);
  player.y = clamp(player.y + dy * speed * dt, 5, WORLD.height - 5);
  player.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
}

export function predictLocalWorld(world, playerIndex, input, dt) {
  const safeDt = clamp(Number(dt) || 0, 0, 0.05);
  if (!world || safeDt <= 0) return world;
  predictBoat(world, playerIndex, input || {}, safeDt);
  predictPerson(world, playerIndex, input || {}, safeDt);
  return world;
}
