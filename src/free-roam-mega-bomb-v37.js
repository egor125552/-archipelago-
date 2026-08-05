"use strict";

import * as base from "./free-roam-mega-bomb-v36.js?v=37";

export * from "./free-roam-mega-bomb-v36.js?v=37";

export const HOSTILE_BOMB_SEMANTICS_VERSION = "1.0.0";

const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

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

function graceActive(world, index) {
  return Number.isInteger(index)
    && (Number(world.freeThreatDirector?.graceUntil?.[index]) || 0) > (Number(world.time) || 0);
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
  world.events.push({type, text, targets, at: world.time, operationEvent: true, hostileBombSemanticsVersion: HOSTILE_BOMB_SEMANTICS_VERSION, ...extra});
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

export function launchPendingEliteBossBombs(world) {
  const boss = world?.freeEliteBoatBoss;
  if (!boss) return 0;
  const pending = values(boss.bombRequests).map(request => ({...request, targetPlayer: hostileBombTargetPlayerV37(world, request)}));
  const launchable = pending.filter(request => !graceActive(world, request.targetPlayer));
  boss.bombRequests = launchable;
  const before = new Set(values(world.freeMegaBombs?.projectiles).map(projectile => String(projectile?.id || "")));
  const launched = base.launchPendingEliteBossBombs(world);
  const fresh = values(world.freeMegaBombs?.projectiles).filter(projectile => !before.has(String(projectile?.id || "")) && Number(projectile?.owner) < 0);
  for (const projectile of fresh) {
    const match = launchable.filter(request => request.sourceId === (projectile.sourceBoatId || projectile.sourceActorId))
      .sort((a, b) => distance(a, projectile) - distance(b, projectile))[0];
    projectile.targetPlayer = Number.isInteger(match?.targetPlayer) ? match.targetPlayer : hostileBombTargetPlayerV37(world, projectile);
    projectile.hostile = true;
  }
  return launched;
}

export function cancelGraceProtectedHostileBombsV37(world) {
  const state = world?.freeMegaBombs;
  if (!state) return 0;
  let cancelled = 0;
  const survivors = [];
  for (const projectile of values(state.projectiles)) {
    if (Number(projectile?.owner) >= 0 || !graceActive(world, Number(projectile?.targetPlayer))) {
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
    });
  }
  state.projectiles = survivors;
  return cancelled;
}

export function stepMegaBombs(world, dt) {
  cancelGraceProtectedHostileBombsV37(world);
  const targetByProjectile = new Map(values(world?.freeMegaBombs?.projectiles).map(projectile => [
    String(projectile?.id || ""),
    Number.isInteger(projectile?.targetPlayer) ? projectile.targetPlayer : null,
  ]));
  const eventStart = values(world?.events).length;
  base.stepMegaBombs(world, dt);
  for (const event of values(world?.events).slice(eventStart)) {
    if (event?.type !== "mega-bomb-explosion" || Number(event.sourcePlayer) >= 0) continue;
    event.hostile = true;
    event.hostileBombSemanticsVersion = HOSTILE_BOMB_SEMANTICS_VERSION;
    event.text = hostileExplosionTextV37(event);
    const targetPlayer = targetByProjectile.get(String(event.projectileId || ""));
    if (Number.isInteger(targetPlayer)) {
      event.targetPlayer = targetPlayer;
      event.targets = [targetPlayer];
    }
  }
}
