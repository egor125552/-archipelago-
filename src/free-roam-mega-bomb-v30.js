"use strict";

import * as base from "./free-roam-mega-bomb-v29.js";

export * from "./free-roam-mega-bomb-v29.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function refreshLaunchEvent(world, projectile) {
  for (let index = (world.events || []).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launch" || event.projectileId !== projectile.id) continue;
    Object.assign(event, projectile, {
      projectileId: projectile.id,
      speed: Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0, Number(projectile.vz) || 0),
    });
    break;
  }
}

export function launchMegaBomb(world, playerIndex) {
  const known = new Set((world?.freeMegaBombs?.projectiles || []).map(item => item?.id));
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;

  const projectile = [...(world.freeMegaBombs?.projectiles || [])]
    .reverse()
    .find(item => item?.owner === playerIndex && !known.has(item?.id));
  if (!projectile) return true;

  const dx = (Number(projectile.targetX) || projectile.x) - projectile.x;
  const dy = (Number(projectile.targetY) || projectile.y) - projectile.y;
  const targetLength = Math.hypot(dx, dy) || 1;
  const currentSpeed = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
  const desiredVx = dx / targetLength * currentSpeed;
  const desiredVy = dy / targetLength * currentSpeed;

  // Тяжёлая бомба меньше гуляет по сторонам, чуть медленнее набирает высоту
  // и лучше сохраняет направление к выбранной точке.
  projectile.vx = (Number(projectile.vx) || 0) * 0.58 + desiredVx * 0.42;
  projectile.vy = (Number(projectile.vy) || 0) * 0.58 + desiredVy * 0.42;
  projectile.vx *= 0.95;
  projectile.vy *= 0.95;
  projectile.vz = clamp((Number(projectile.vz) || 0) * 0.9, 5.4, 18.5);
  projectile.energy = clamp((Number(projectile.energy) || 1) * 1.04, 0, 1);
  projectile.throwVariationDeg = (Number(projectile.throwVariationDeg) || 0) * 0.55;
  projectile.realisticHeavyFlight = true;

  refreshLaunchEvent(world, projectile);
  return true;
}
