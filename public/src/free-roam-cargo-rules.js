"use strict";

export const SHORE_Y = 72;
export const CARGO_ACTION_RANGE = 12;
export const LANDING_MIN_X = 162;
export const LANDING_MAX_X = 258;
export const DOCK_FOOT_MIN_X = 148;
export const DOCK_FOOT_MAX_X = 272;
export const DOCK_FOOT_MIN_Y = 50;
export const DOCK_FOOT_MAX_Y = 82;

export const clampCargoCoordinate = (value, min, max) => Math.max(min, Math.min(max, value));

export function isFootDockZone(player) {
  return Boolean(
    player
    && ["foot", "swim"].includes(player.mode)
    && player.x >= DOCK_FOOT_MIN_X
    && player.x <= DOCK_FOOT_MAX_X
    && player.y >= DOCK_FOOT_MIN_Y
    && player.y <= DOCK_FOOT_MAX_Y
  );
}
