"use strict";

const STATIONARY_LIMIT = 24;
const HOLD_TIME = 520;

export function classifyActionGesture({pointers, duration, dx, dy, movement, taps = 1}) {
  const count = Math.max(1, Number(pointers) || 1);
  const held = (Number(duration) || 0) >= HOLD_TIME;
  const moved = (Number(movement) || 0) > STATIONARY_LIMIT;
  const horizontal = Math.abs(Number(dx) || 0);
  const vertical = Math.abs(Number(dy) || 0);

  if (moved) {
    if (count !== 2) return null;
    if (horizontal > vertical * 1.15) return "weapon";
    if ((Number(dy) || 0) < 0) return "status";
    return "buttons";
  }

  if (count === 1) {
    if (held) return "attack-heavy";
    return taps >= 2 ? "jump" : "action";
  }
  if (count === 2) return held ? "repair" : "pump";
  return held ? "attack-heavy" : "attack-light";
}

export function gestureMetrics(group) {
  const points = [...(group?.points?.values?.() || [])];
  if (!points.length) return {pointers: 1, duration: Infinity, dx: 0, dy: 0, movement: 0};
  const deltas = points.map(point => ({
    dx: (Number(point.lastX) || 0) - (Number(point.x) || 0),
    dy: (Number(point.lastY) || 0) - (Number(point.y) || 0),
  }));
  const dx = deltas.reduce((sum, point) => sum + point.dx, 0) / deltas.length;
  const dy = deltas.reduce((sum, point) => sum + point.dy, 0) / deltas.length;
  return {
    pointers: Math.max(Number(group.maxPointers) || 0, points.length),
    duration: Math.max(0, performance.now() - (Number(group.startedAt) || 0)),
    dx,
    dy,
    movement: Math.max(...deltas.map(point => Math.hypot(point.dx, point.dy))),
  };
}
