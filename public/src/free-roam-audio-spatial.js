"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

export function relativeMovementPan(listener, source) {
  const dx = (Number(source?.x) || 0) - (Number(listener?.x) || 0);
  const dy = (Number(source?.y) || 0) - (Number(listener?.y) || 0);
  const metres = Math.hypot(dx, dy);
  if (metres < 0.001) return 0;
  if (["foot", "swim"].includes(listener?.mode)) {
    return clamp(dx / Math.max(metres, 8), -1, 1);
  }
  const absolute = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relative = wrapDeg(absolute - (Number(listener?.heading) || 0));
  return clamp(Math.sin(relative * Math.PI / 180), -1, 1);
}
