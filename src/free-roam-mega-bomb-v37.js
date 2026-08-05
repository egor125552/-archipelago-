"use strict";

import * as base from "./free-roam-mega-bomb-v36.js?v=38";
import {hostileRespawnGraceActive} from "../public/src/free-roam-hostile-respawn-grace.js?v=1";

export * from "./free-roam-mega-bomb-v36.js?v=38";

export const HOSTILE_BOMB_SEMANTICS_VERSION = "1.1.0";

const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const headingVector = heading => ({
  x: Math.sin((Number(heading) || 0) * Math.PI / 180),
  y: -Math.cos((Number(heading) || 0) * Math.PI / 180),
});

function playerPoint(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}


export function hostileBombTargetPlayerV37(world, request) {
  if (Number.isInteger(request?.targetPlayer)) return request.targetPlayer;
  const target = {x: Number(request?.targetX), y: Number(request?.targetY)};
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  const candidates = values(world.players).map((player, index) => ({index, point: playerPoint(world, index)}))
    .filter(item => item.point)
    .sort((a, b) => distance(target, a.point) - distance(target, b.point));
  return candidates[0] && distance(target, candidates[0].point) <= 62 ? candidates[0].index : null;
}

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({
    type,
    text,
    targets,
    at: world.time,
    operationEvent: true,
    hostileBombSemanticsVersion: HOSTILE_BOMB_SEMANTICS_VERSION,
    ...extra,
  });
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function hostileExplosionTextV37(event) {
  if (event?.reason === "respawn-grace") {
    return "Вражеская бомба взорвалась во время двухсекундной защиты и не нанесла урона.";
  }
  const deaths = Math.max(0, Number(event?.playerDeathCount) || 0);
  const players = Math.max(0, Number(event?.playerHitCount) || 0);
  const boats = Math.max(0, Number(event?.boatHitCount) || 0);
  const hits = Math.max(0, Number(event?.hitCount) || 0);
  if (deaths > 0) return deaths > 1 ? "Вражеская бомба убила игроков." : "Вражеская бомба попала. Игрок погиб.";
  if (players > 0 && boats > 0) return "Вражеская бомба задела игрока и повредила лодку.";
  if (players > 0) return "Вражеская бомба попала по игроку.";
  if (boats > 0) return "Вражеская бомба повредила лодку.";
  if (hits <= 0) return "Вражеская бомба промахнулась.";
  return "Вражеская бомба взорвалась.";
}

function sourceForRequest(world, request) {
  if (request?.sourceType === "elite-commander") {
    return values(world?.freeHostileActors?.actors)
      .find(actor => actor?.id === request.sourceId && actor.active && !actor.destroyed) || null;
  }
  const boat = world?.freeEliteBoatBoss?.boat;
  return boat?.alive && boat.id === request?.sourceId ? boat : null;
}

function replaceDirectionalInheritance(projectile, source, request) {
  if (!projectile || !source || request?.sourceType !== "elite-boat") return;
  const launchDirection = headingVector(request.heading);
  const sourceSpeed = Number(source.speed) || 0;
  const oldInheritedVx = launchDirection.x * sourceSpeed * 0.82;
  const oldInheritedVy = launchDirection.y * sourceSpeed * 0.82;
  const requestedVx = (Number(request.sourceVx) || 0) * 0.82;
  const requestedVy = (Number(request.sourceVy) || 0) * 0.82;
  projectile.vx += requestedVx - oldInheritedVx;
  projectile.vy += requestedVy - oldInheritedVy;
  projectile.heading = Math.atan2(projectile.vx, -projectile.vy) * 180 / Math.PI;
  projectile.launchSpeed = Math.hypot(projectile.vx, projectile.vy);
  projectile.sourceVelocityVx = Number(request.sourceVx) || 0;
  projectile.sourceVelocityVy = Number(request.sourceVy) || 0;
  projectile.tacticalRole = request.tacticalRole || null;
}

function refreshHostileLaunchEvent(world, projectile, request) {
  for (let index = values(world.events).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "mega-bomb-launch" || event.projectileId !== projectile.id) continue;
    Object.assign(event, {
      vx: projectile.vx,
      vy: projectile.vy,
      heading: projectile.heading,
      speed: Math.hypot(projectile.vx, projectile.vy, projectile.vz),
      targetPlayer: request.targetPlayer,
      tacticalRole: request.tacticalRole || null,
      sourceVelocityVx: projectile.sourceVelocityVx,
      sourceVelocityVy: projectile.sourceVelocityVy,
    });
    return;
  }
}

export function launchPendingEliteBossBombs(world) {
  const boss = world?.freeEliteBoatBoss;
  if (!boss) return 0;
  const pending = values(boss.bombRequests)
    .map(request => ({...request, targetPlayer: hostileBombTargetPlayerV37(world, request)}));
  const launchable = pending.filter(request => !hostileRespawnGraceActive(world, request.targetPlayer));
  boss.bombRequests = launchable;
  const before = new Set(values(world.freeMegaBombs?.projectiles).map(projectile => String(projectile?.id || "")));
  const launched = base.launchPendingEliteBossBombs(world);
  const fresh = values(world.freeMegaBombs?.projectiles)
    .filter(projectile => !before.has(String(projectile?.id || "")));

  for (let index = 0; index < fresh.length; index += 1) {
    const projectile = fresh[index];
    const request = launchable[index] || launchable.find(candidate => (
      candidate.sourceId === (projectile.sourceBoatId || projectile.sourceActorId)
    )) || pending[index] || pending[0] || null;
    projectile.targetPlayer = Number.isInteger(request?.targetPlayer)
      ? request.targetPlayer
      : hostileBombTargetPlayerV37(world, projectile);
    projectile.hostile = true;
    projectile.tacticalRole = request?.tacticalRole || null;
    const source = sourceForRequest(world, request);
    replaceDirectionalInheritance(projectile, source, request);
    refreshHostileLaunchEvent(world, projectile, request || {});
  }
  return launched;
}

export function cancelGraceProtectedHostileBombsV37(world) {
  const state = world?.freeMegaBombs;
  if (!state) return 0;
  let cancelled = 0;
  const survivors = [];
  for (const projectile of values(state.projectiles)) {
    if (Number(projectile?.owner) >= 0 || !hostileRespawnGraceActive(world, Number(projectile?.targetPlayer))) {
      survivors.push(projectile);
      continue;
    }
    cancelled += 1;
    emit(world, "mega-bomb-explosion", hostileExplosionTextV37({reason: "respawn-grace"}), [projectile.targetPlayer], {
      sourcePlayer: -1,
      hostile: true,
      projectileId: projectile.id,
      reason: "respawn-grace",
      surface: "air",
      x: projectile.x,
      y: projectile.y,
      z: projectile.z,
      radius: 0,
      hitCount: 0,
      playerHitCount: 0,
      playerDeathCount: 0,
      stunnedCount: 0,
      boatHitCount: 0,
      disabledBoatCount: 0,
      destroyedCount: 0,
      blockedCount: 0,
      heavyDamage: 0,
      tacticalRole: projectile.tacticalRole || null,
    });
  }
  state.projectiles = survivors;
  return cancelled;
}

export function stepMegaBombs(world, dt) {
  cancelGraceProtectedHostileBombsV37(world);
  const targetByProjectile = new Map(values(world?.freeMegaBombs?.projectiles).map(projectile => [
    String(projectile?.id || ""),
    {
      targetPlayer: Number.isInteger(projectile?.targetPlayer) ? projectile.targetPlayer : null,
      tacticalRole: projectile?.tacticalRole || null,
    },
  ]));
  const eventStart = values(world?.events).length;
  base.stepMegaBombs(world, dt);
  for (const event of values(world?.events).slice(eventStart)) {
    if (event?.type !== "mega-bomb-explosion" || Number(event.sourcePlayer) >= 0) continue;
    event.hostile = true;
    event.hostileBombSemanticsVersion = HOSTILE_BOMB_SEMANTICS_VERSION;
    event.text = hostileExplosionTextV37(event);
    const metadata = targetByProjectile.get(String(event.projectileId || ""));
    if (Number.isInteger(metadata?.targetPlayer)) {
      event.targetPlayer = metadata.targetPlayer;
      event.targets = [metadata.targetPlayer];
    }
    event.tacticalRole = metadata?.tacticalRole || event.tacticalRole || null;
  }
}
