"use strict";

export * from "./free-roam-mega-bomb-v25.js";
import * as base from "./free-roam-mega-bomb-v25.js";

const MIN_X = 4;
const MAX_X = 416;
const MIN_Y = 4;
const MAX_Y = 316;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function idNumber(projectile) {
  return Number(String(projectile?.id || "").match(/\d+$/)?.[0]) || 1;
}

function effectiveCurve(midpoint, normal, control, side) {
  return Math.max(0, ((control.x - midpoint.x) * normal.x + (control.y - midpoint.y) * normal.y) * side);
}

function improveTrajectory(projectile) {
  if (!projectile) return;
  const start = {x: Number(projectile.startX), y: Number(projectile.startY)};
  const target = {x: Number(projectile.targetX), y: Number(projectile.targetY)};
  if (![start.x, start.y, target.x, target.y].every(Number.isFinite)) return;

  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const pathDistance = Math.max(0.001, Math.hypot(dx, dy));
  const normal = {x: -dy / pathDistance, y: dx / pathDistance};
  const midpoint = {x: (start.x + target.x) / 2, y: (start.y + target.y) / 2};
  const wantedCurve = clamp(pathDistance * 0.62, 18, 64);
  const preferredSide = idNumber(projectile) % 2 ? -1 : 1;

  const candidate = side => ({
    side,
    control: {
      x: clamp(midpoint.x + normal.x * wantedCurve * side, MIN_X, MAX_X),
      y: clamp(midpoint.y + normal.y * wantedCurve * side, MIN_Y, MAX_Y),
    },
  });
  const preferred = candidate(preferredSide);
  const alternate = candidate(-preferredSide);
  preferred.effective = effectiveCurve(midpoint, normal, preferred.control, preferred.side);
  alternate.effective = effectiveCurve(midpoint, normal, alternate.control, alternate.side);
  const chosen = alternate.effective > preferred.effective + 10 ? alternate : preferred;

  projectile.controlX = chosen.control.x;
  projectile.controlY = chosen.control.y;
  projectile.arcHeight = clamp(20 + pathDistance * 0.13, 24, 39);
  projectile.arcSkew = 0.92 + (idNumber(projectile) % 5) * 0.035;
  projectile.flightTime = clamp(pathDistance / 49 * 1.18, 1.0, 4.05);
  projectile.audioArcSide = chosen.side;
  projectile.audioArcStrength = clamp(chosen.effective / Math.max(12, pathDistance * 0.30), 0.45, 1);
}

function refreshLaunchEvent(world, projectile) {
  const events = Array.isArray(world?.events) ? world.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "mega-bomb-launch") continue;
    if (event.projectileId !== projectile.id && event.id !== projectile.id) continue;
    Object.assign(event, projectile, {projectileId: projectile.id});
    break;
  }
}

export function launchMegaBomb(world, playerIndex) {
  const stateBefore = world?.freeMegaBombs;
  const known = new Set(Array.isArray(stateBefore?.projectiles)
    ? stateBefore.projectiles.map(item => item?.id)
    : []);
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;

  const projectiles = Array.isArray(world?.freeMegaBombs?.projectiles)
    ? world.freeMegaBombs.projectiles
    : [];
  const projectile = [...projectiles].reverse().find(item => item?.owner === playerIndex && !known.has(item?.id));
  if (!projectile) return true;
  improveTrajectory(projectile);
  refreshLaunchEvent(world, projectile);
  return true;
}
