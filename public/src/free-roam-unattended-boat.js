"use strict";

export function unattendedLeakMultiplier(boat, shoreY = 72) {
  const mooredWithoutDriver = boat?.driver == null
    && Math.abs(Number(boat.speed) || 0) < 0.35
    && Number(boat.y) <= shoreY + 18;
  return mooredWithoutDriver ? 0 : 1;
}
