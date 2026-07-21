"use strict";

export function directionFromDelta(dx, dy, threshold = 26) {
  if (Math.hypot(Number(dx) || 0, Number(dy) || 0) < threshold) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function isTwoFingerTap({maxPointers, duration, movements}, options = {}) {
  const maxDuration = options.maxDuration ?? 620;
  const maxMovement = options.maxMovement ?? 24;
  return maxPointers === 2
    && duration <= maxDuration
    && Array.isArray(movements)
    && movements.length === 2
    && movements.every(value => value <= maxMovement);
}
