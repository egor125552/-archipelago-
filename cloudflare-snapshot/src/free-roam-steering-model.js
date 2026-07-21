"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function operationSteeringDelta(speed, steer, dt) {
  const direction = Math.sign(Number(speed) || 1);
  const accessibleFactor = clamp(Math.abs(Number(speed) || 0) / 4.5, 0.45, 1.35);
  const detailedFactor = clamp(Math.abs(Number(speed) || 0) / 4, 0.55, 1.3);
  const extraAuthority = 0.31 * accessibleFactor + 0.13 * detailedFactor;
  return Math.sign(Number(steer) || 0) * extraAuthority * clamp(Number(dt) || 0, 0, 0.1) * 60 * direction;
}

export function shouldCenterRudder(steer) {
  return Number(steer) === 0;
}
