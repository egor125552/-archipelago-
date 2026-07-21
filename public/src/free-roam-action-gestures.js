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
    if ((Number(dy) || 0) < 0) return "pump";
    // A downward two-finger swipe used to disable gesture mode entirely.
    // It is intentionally unassigned now so an imprecise swipe cannot lock
    // a touch player out of the gesture controls.
    return null;
  }

  if (count === 1) {
    if (held) return "attack-heavy";
    return taps >= 2 ? "jump" : "action";
  }
  if (count === 2) {
    if (held) return "repair";
    return taps >= 2 ? "status" : "sonar";
  }
  if (count === 3) {
    if (taps >= 2) return "targets";
    return held ? "attack-heavy" : "attack-light";
  }
  if (count === 4) return "guide";
  return null;
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
    pointers: Math.max(Number(group?.maxPointers) || 0, points.length),
    duration: performance.now() - (Number(group?.startedAt) || performance.now()),
    dx,
    dy,
    movement: Math.hypot(dx, dy),
  };
}
