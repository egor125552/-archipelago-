"use strict";

import * as physicsBase from "./free-roam-mega-bomb-v28.js";

export * from "./free-roam-mega-bomb-v31.js";

const START_STOCK = 25;
const MAX_STOCK = 145;
const COMPATIBILITY_MAGAZINE = 25;
const STOCK_VERSION = 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function syncCompatibilityMagazine(combat) {
  if (!combat) return 0;
  const stock = clamp(Math.floor(Number(combat.megaBombStock) || 0), 0, MAX_STOCK);
  combat.megaBombStock = stock;
  combat.megaBombAmmo = Math.min(COMPATIBILITY_MAGAZINE, stock);
  return stock;
}

function ensureStock(combat) {
  if (!combat) return 0;
  const savedStock = Number(combat.megaBombStock);
  if (!Number.isFinite(savedStock)) {
    const oldMagazine = Math.max(0, Math.floor(Number(combat.megaBombAmmo) || 0));
    const oldReserve = Math.max(0, Math.floor(Number(combat.megaBombReserve) || 0));
    combat.megaBombStock = clamp(oldMagazine + oldReserve, 0, MAX_STOCK);
    if (!Number.isFinite(Number(combat.megaBombAmmo)) && oldReserve === 0) {
      combat.megaBombStock = START_STOCK;
    }
  }
  combat.megaBombStockVersion = STOCK_VERSION;
  delete combat.megaBombReserve;
  return syncCompatibilityMagazine(combat);
}

function patchLaunchEvents(world, playerIndex, projectile, remaining) {
  let launchPatched = !projectile;
  let statusPatched = false;
  for (let index = (world.events || []).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (!launchPatched && event?.type === "mega-bomb-launch" && event.projectileId === projectile.id) {
      Object.assign(event, projectile, {
        projectileId: projectile.id,
        speed: Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0, Number(projectile.vz) || 0),
      });
      launchPatched = true;
    }
    if (!statusPatched && event?.type === "mega-bomb-launched-status" && event.targets?.[0] === playerIndex) {
      event.remaining = remaining;
      event.text = `Мега-бомба запущена. Осталось ${remaining}.`;
      statusPatched = true;
    }
    if (launchPatched && statusPatched) break;
  }
}

export function ensureMegaBombState(world) {
  const state = physicsBase.ensureMegaBombState(world);
  for (const player of world?.players || []) ensureStock(player?.combat);
  return state;
}

export function reportMegaBombStatus(world, playerIndex) {
  ensureMegaBombState(world);
  const remaining = ensureStock(world.players?.[playerIndex]?.combat);
  emit(world, "mega-bomb-status", "", [playerIndex], {sourcePlayer: playerIndex, remaining});
  return remaining;
}

export function launchMegaBomb(world, playerIndex) {
  const state = ensureMegaBombState(world);
  const combat = world.players?.[playerIndex]?.combat;
  const stockBefore = ensureStock(combat);
  if (!state || !combat) return false;

  combat.megaBombAmmo = Math.min(COMPATIBILITY_MAGAZINE, stockBefore);
  const known = new Set((state.projectiles || []).map(item => item?.id));
  const launched = physicsBase.launchMegaBomb(world, playerIndex);
  if (!launched) {
    syncCompatibilityMagazine(combat);
    return false;
  }

  combat.megaBombStock = Math.max(0, stockBefore - 1);
  const remaining = syncCompatibilityMagazine(combat);
  const projectile = [...(state.projectiles || [])]
    .reverse()
    .find(item => item?.owner === playerIndex && !known.has(item?.id));

  if (projectile) {
    const dx = (Number(projectile.targetX) || projectile.x) - projectile.x;
    const dy = (Number(projectile.targetY) || projectile.y) - projectile.y;
    const targetLength = Math.hypot(dx, dy) || 1;
    const currentSpeed = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
    const desiredVx = dx / targetLength * currentSpeed;
    const desiredVy = dy / targetLength * currentSpeed;

    projectile.vx = (Number(projectile.vx) || 0) * 0.58 + desiredVx * 0.42;
    projectile.vy = (Number(projectile.vy) || 0) * 0.58 + desiredVy * 0.42;
    projectile.vx *= 0.95;
    projectile.vy *= 0.95;
    projectile.vz = clamp((Number(projectile.vz) || 0) * 0.9, 5.4, 18.5);
    projectile.energy = clamp((Number(projectile.energy) || 1) * 1.04, 0, 1);
    projectile.throwVariationDeg = (Number(projectile.throwVariationDeg) || 0) * 0.55;
    projectile.realisticHeavyFlight = true;
  }

  patchLaunchEvents(world, playerIndex, projectile, remaining);
  return true;
}

export function megaBombStatus(world) {
  ensureMegaBombState(world);
  const status = physicsBase.megaBombStatus(world);
  status.ammo = (world.players || []).map(player => ensureStock(player?.combat));
  return status;
}
