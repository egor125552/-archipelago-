"use strict";

import {CONFIG} from "./game-core-v18.js?free=prediction";
import {WORLD} from "./free-roam-core-v6.js?v=44";
import {operationSteeringDelta} from "./free-roam-steering-model.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = degrees => degrees * Math.PI / 180;

function blendAngle(authoritative, predicted, keep) {
  const difference = wrapDeg((Number(predicted) || 0) - (Number(authoritative) || 0));
  return wrapDeg((Number(authoritative) || 0) + difference * keep);
}

function movementDirection(input = {}) {
  let x = Number(Boolean(input.right)) - Number(Boolean(input.left));
  let y = Number(Boolean(input.down)) - Number(Boolean(input.up));
  const length = Math.hypot(x, y);
  if (length < 0.001) return null;
  x /= length;
  y /= length;
  return {x, y};
}

function authoritativePersonCorrection(previousPlayer, nextPlayer) {
  const previousCombat = previousPlayer?.combat;
  const nextCombat = nextPlayer?.combat;
  if (previousCombat?.alive !== nextCombat?.alive) return true;
  if (previousCombat?.knockedDown !== nextCombat?.knockedDown) return true;
  const previousHealth = Number(previousCombat?.health);
  const nextHealth = Number(nextCombat?.health);
  return Number.isFinite(previousHealth)
    && Number.isFinite(nextHealth)
    && nextHealth < previousHealth - 0.01;
}

export function localPredictionLeadSeconds({networkRttMs, inputReceiptMs, controlLatencyMs} = {}) {
  const preferred = [networkRttMs, inputReceiptMs, controlLatencyMs]
    .map(Number)
    .find(value => Number.isFinite(value) && value > 0);
  if (!preferred) return 0;
  return clamp(preferred / 2_000, 0, 0.18);
}

export function reconcileLocalPrediction(previousWorld, nextWorld, playerIndex, options = {}) {
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
    if (authoritativePersonCorrection(previousPlayer, nextPlayer)) return nextWorld;
    const direction = movementDirection(options.input);
    const deltaX = (Number(nextPlayer.x) || 0) - (Number(previousPlayer.x) || 0);
    const deltaY = (Number(nextPlayer.y) || 0) - (Number(previousPlayer.y) || 0);
    const error = Math.hypot(deltaX, deltaY);

    if (direction) {
      const along = deltaX * direction.x + deltaY * direction.y;
      const perpendicularX = deltaX - direction.x * along;
      const perpendicularY = deltaY - direction.y * along;
      const lateralCorrection = 0.18;
      const forwardCorrection = along > 0 ? 0.65 : 0;
      nextPlayer.x = previousPlayer.x
        + direction.x * along * forwardCorrection
        + perpendicularX * lateralCorrection;
      nextPlayer.y = previousPlayer.y
        + direction.y * along * forwardCorrection
        + perpendicularY * lateralCorrection;
      nextPlayer.heading = blendAngle(nextPlayer.heading, previousPlayer.heading, 0.86);
      return nextWorld;
    }

    if (error > 8) return nextWorld;
    const latencyBlend = clamp(((Number(options.networkRttMs) || 0) - 40) / 240, 0, 1);
    const keep = 0.82 + latencyBlend * 0.16;
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
  const minimumX = player.mode === "foot" ? Number(WORLD.landMinX) || 5 : 5;
  const maximumX = player.mode === "foot" ? Number(WORLD.landMaxX) || WORLD.width - 5 : WORLD.width - 5;
  const minimumY = player.mode === "foot" ? Number(WORLD.landMinY) || 5 : 5;
  const maximumY = player.mode === "foot" ? Number(WORLD.landMaxY) || WORLD.shoreY + 4 : WORLD.height - 5;
  player.x = clamp(player.x + dx * speed * dt, minimumX, maximumX);
  player.y = clamp(player.y + dy * speed * dt, minimumY, maximumY);
  player.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
}

export function predictLocalWorld(world, playerIndex, input, dt) {
  const safeDt = clamp(Number(dt) || 0, 0, 0.05);
  if (!world || safeDt <= 0) return world;
  predictBoat(world, playerIndex, input || {}, safeDt);
  predictPerson(world, playerIndex, input || {}, safeDt);
  return world;
}

export function predictLocalWorldAhead(world, playerIndex, input, seconds) {
  let remaining = clamp(Number(seconds) || 0, 0, 0.18);
  while (remaining > 0.0001) {
    const chunk = Math.min(0.05, remaining);
    predictLocalWorld(world, playerIndex, input, chunk);
    remaining -= chunk;
  }
  return world;
}
