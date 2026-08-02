"use strict";

import * as base from "./free-roam-mega-bomb-v29.js";

export * from "./free-roam-mega-bomb-v29.js";

const ACTIVE_MAGAZINE = 25;
const TOTAL_MAXIMUM = 145;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureReserve(combat) {
  if (!combat) return 0;
  combat.megaBombReserve = clamp(Math.floor(Number(combat.megaBombReserve) || 0), 0, TOTAL_MAXIMUM - ACTIVE_MAGAZINE);
  return combat.megaBombReserve;
}

function totalAmmo(combat) {
  return Math.max(0, Math.floor(Number(combat?.megaBombAmmo) || 0)) + ensureReserve(combat);
}

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

function patchRemainingStatus(world, playerIndex, remaining) {
  for (let index = (world.events || []).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launched-status" || event.targets?.[0] !== playerIndex) continue;
    event.remaining = remaining;
    event.text = `Мега-бомба запущена. Осталось ${remaining}.`;
    break;
  }
}

export function ensureMegaBombState(world) {
  const state = base.ensureMegaBombState(world);
  for (const player of world?.players || []) ensureReserve(player?.combat);
  return state;
}

export function reportMegaBombStatus(world, playerIndex) {
  ensureMegaBombState(world);
  const remaining = totalAmmo(world.players?.[playerIndex]?.combat);
  emit(world, "mega-bomb-status", "", [playerIndex], {sourcePlayer: playerIndex, remaining});
  return remaining;
}

export function launchMegaBomb(world, playerIndex) {
  ensureMegaBombState(world);
  const combat = world.players?.[playerIndex]?.combat;
  const known = new Set((world?.freeMegaBombs?.projectiles || []).map(item => item?.id));
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;

  if (combat && ensureReserve(combat) > 0 && Number(combat.megaBombAmmo) < ACTIVE_MAGAZINE) {
    combat.megaBombReserve -= 1;
    combat.megaBombAmmo = Math.min(ACTIVE_MAGAZINE, Number(combat.megaBombAmmo) + 1);
  }

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

  projectile.vx = (Number(projectile.vx) || 0) * 0.58 + desiredVx * 0.42;
  projectile.vy = (Number(projectile.vy) || 0) * 0.58 + desiredVy * 0.42;
  projectile.vx *= 0.95;
  projectile.vy *= 0.95;
  projectile.vz = clamp((Number(projectile.vz) || 0) * 0.9, 5.4, 18.5);
  projectile.energy = clamp((Number(projectile.energy) || 1) * 1.04, 0, 1);
  projectile.throwVariationDeg = (Number(projectile.throwVariationDeg) || 0) * 0.55;
  projectile.realisticHeavyFlight = true;

  refreshLaunchEvent(world, projectile);
  patchRemainingStatus(world, playerIndex, totalAmmo(combat));
  return true;
}

export function megaBombStatus(world) {
  const status = base.megaBombStatus(world);
  status.ammo = (world.players || []).map(player => totalAmmo(player?.combat));
  return status;
}
