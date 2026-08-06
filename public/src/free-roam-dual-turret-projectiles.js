"use strict";

import {applyCollisionDamage} from "./collision-model.js";
import {applyCombatDamage} from "./free-roam-combat-v2.js?v=6";
import {damageEnemyBoat} from "./free-roam-enemy-boats.js?v=3";
import {damageEscort} from "./free-roam-pursuer-squad.js?v=33";
import {damageHostileGunner} from "./free-roam-hostile-gunners.js?v=32";
import {damageHostileActor} from "./free-roam-hostile-actors.js?v=3";
import {damageHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=4";
import {damageEliteBoatBoss} from "./free-roam-elite-boat.js?v=2";
import {releaseStolenCargo} from "./free-roam-marauder.js?v=33";
import {listCombatTargets} from "./free-roam-targeting.js?v=39";
import {
  DUAL_TURRET_PROJECTILE_SPEED,
  DUAL_TURRET_PROJECTILE_TTL,
  DUAL_TURRET_SHOT_DAMAGE,
} from "./free-roam-dual-turret-config.js?v=2";
import {applyDualTurretBoatDamage, isDualTurretBoat} from "./free-roam-dual-turret-boat.js";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const rad = value => Number(value) * Math.PI / 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function stateFor(world) {
  world.freeDualTurretProjectiles ||= {nextId: 1, projectiles: [], endEvents: []};
  const state = world.freeDualTurretProjectiles;
  if (!Array.isArray(state.projectiles)) state.projectiles = [];
  if (!Array.isArray(state.endEvents)) state.endEvents = [];
  if (!Number.isInteger(state.nextId)) state.nextId = 1;
  return state;
}

function boatVelocity(boat) {
  const heading = rad(boat?.heading || 0);
  return {
    x: Math.sin(heading) * (Number(boat?.speed) || 0),
    y: -Math.cos(heading) * (Number(boat?.speed) || 0),
  };
}

export function spawnDualTurretProjectile(world, {boat, turret, sourcePlayer, heading, targetId = null}) {
  const state = stateFor(world);
  const direction = rad(heading);
  const boatDirection = rad(boat.heading);
  const side = Number(turret.side) || 0;
  const forward = 4.6;
  const lateral = 4.2 * side;
  const x = boat.x + Math.sin(boatDirection) * forward + Math.cos(boatDirection) * lateral;
  const y = boat.y - Math.cos(boatDirection) * forward + Math.sin(boatDirection) * lateral;
  const inherited = boatVelocity(boat);
  const projectile = {
    id: `dual-shot-${state.nextId++}`,
    turretId: turret.id,
    sourcePlayer,
    sourceBoatId: boat.id,
    targetId,
    x,
    y,
    previousX: x,
    previousY: y,
    vx: Math.sin(direction) * DUAL_TURRET_PROJECTILE_SPEED + inherited.x * 0.82,
    vy: -Math.cos(direction) * DUAL_TURRET_PROJECTILE_SPEED + inherited.y * 0.82,
    launchHeading: heading,
    inheritedBoatVelocity: {x: inherited.x * 0.82, y: inherited.y * 0.82},
    speed: DUAL_TURRET_PROJECTILE_SPEED,
    age: 0,
    ttl: DUAL_TURRET_PROJECTILE_TTL,
    damage: DUAL_TURRET_SHOT_DAMAGE,
    endReason: null,
  };
  state.projectiles.push(projectile);
  return projectile;
}

function pointSegmentContact(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) {
    return {distance: Math.hypot(point.x - from.x, point.y - from.y), progress: 0};
  }
  const progress = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1);
  const x = from.x + dx * progress;
  const y = from.y + dy * progress;
  return {distance: Math.hypot(point.x - x, point.y - y), progress};
}

function finishProjectile(world, projectile, reason, extra = {}) {
  projectile.endReason = reason;
  const state = stateFor(world);
  const end = {
    id: projectile.id,
    reason,
    x: projectile.x,
    y: projectile.y,
    sourcePlayer: projectile.sourcePlayer,
    at: world.time,
    ...extra,
  };
  state.endEvents.push(end);
  if (state.endEvents.length > 24) state.endEvents.splice(0, state.endEvents.length - 24);
  emit(world, "dual-turret-projectile-end", "", [0, 1], end);
}

function damageOrdinaryBoat(world, boat, projectile) {
  const impact = applyCollisionDamage(boat, projectile.damage);
  boat.leak = clamp((Number(boat.leak) || 0) + impact.damage * 0.045, 0, 16);
  return impact.damage;
}

function destroyMarauder(world, target, sourcePlayer) {
  const marauder = target.point;
  if (!marauder || marauder.destroyed) return;
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  releaseStolenCargo(world, marauder);
  emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен бортовой установкой.", [0, 1], {
    sourcePlayer,
    weapon: "dual-turret",
    x: marauder.x,
    y: marauder.y,
  });
}

function applyTargetDamage(world, target, projectile) {
  const amount = projectile.damage;
  const sourcePlayer = projectile.sourcePlayer;
  if (target.kind === "player") {
    return applyCombatDamage(world, target.playerIndex, amount, sourcePlayer, {
      weapon: "dual-turret",
      heavy: true,
      eventType: "dual-turret-player-hit",
      sourcePoint: projectile,
    }, {});
  }
  if (target.kind === "boat") {
    const boat = target.point;
    if (isDualTurretBoat(boat)) return applyDualTurretBoatDamage(world, boat, amount, {sourcePlayer}).damage > 0;
    return damageOrdinaryBoat(world, boat, projectile) > 0;
  }
  if (target.kind === "gunner") return damageHostileGunner(world, target.gunnerId, amount, sourcePlayer);
  if (["hostileActor", "elite"].includes(target.kind)) return damageHostileActor(world, target.actorId, amount, sourcePlayer, {weapon: "dual-turret"});
  if (target.kind === "escort") return damageEscort(world, target.pursuerId, amount, sourcePlayer, {});
  if (target.kind === "enemyBoat") return damageEnemyBoat(world, target.enemyBoatId, amount, sourcePlayer, {}, {weapon: "dual-turret"});
  if (["heavyHull", "heavyTurret", "heavyEngine"].includes(target.kind)) {
    return damageHeavyPursuer(world, target.component || "hull", amount, sourcePlayer, {}, {weapon: "dual-turret"});
  }
  if (["eliteArmor", "eliteHull", "eliteTurret", "eliteBombBay"].includes(target.kind)) {
    return damageEliteBoatBoss(world, target.component || "hull", amount, sourcePlayer, {weapon: "dual-turret", turretId: target.turretId});
  }
  if (target.kind === "marauder") {
    target.point.hull = Math.max(0, (Number(target.point.hull) || 0) - amount);
    if (target.point.hull <= 0) destroyMarauder(world, target, sourcePlayer);
    return true;
  }
  return false;
}

function collisionCandidates(world, projectile) {
  const candidates = [];
  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    if (playerIndex === projectile.sourcePlayer || !player?.combat?.alive || player.mode === "boat" || player.mode === "dead") continue;
    candidates.push({kind: "player", playerIndex, point: player, radius: player.mode === "roof" ? 2.2 : 1.3, id: `player-${playerIndex}`});
  }
  for (const boat of world.boats || []) {
    if (!boat || boat.sunk || boat.reserved) continue;
    if (boat.id === projectile.sourceBoatId && projectile.age < 0.22) continue;
    candidates.push({kind: "boat", boatId: boat.id, point: boat, radius: isDualTurretBoat(boat) ? 7.5 : 6, id: `boat-${boat.id}`});
  }
  const listed = listCombatTargets(world, projectile.sourcePlayer, 620);
  const seen = new Set(candidates.map(candidate => `${candidate.kind}:${candidate.id}`));
  for (const target of listed) {
    if (["player", "boat"].includes(target.kind)) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const radius = ["marauder", "escort", "enemyBoat", "heavyHull", "heavyTurret", "heavyEngine", "eliteArmor", "eliteHull", "eliteTurret", "eliteBombBay"].includes(target.kind) ? 6 : 1.8;
    candidates.push({...target, radius});
  }
  return candidates;
}

function hitCandidate(world, projectile, from, to) {
  const candidates = collisionCandidates(world, projectile);
  let selected = null;
  let bestProgress = Infinity;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate.kind === "boat" && candidate.boatId === projectile.sourceBoatId) continue;
    const contact = pointSegmentContact(candidate.point, from, to);
    if (!Number.isFinite(contact.distance) || contact.distance > candidate.radius) continue;
    if (contact.progress > bestProgress + 0.0001) continue;
    if (Math.abs(contact.progress - bestProgress) <= 0.0001 && contact.distance >= bestDistance) continue;
    bestProgress = contact.progress;
    bestDistance = contact.distance;
    selected = candidate;
  }
  if (!selected) return false;
  projectile.x = Number(selected.point.x) || projectile.x;
  projectile.y = Number(selected.point.y) || projectile.y;
  applyTargetDamage(world, selected, projectile);
  emit(world, "dual-turret-hit", "", [0, 1], {
    sourcePlayer: projectile.sourcePlayer,
    projectileId: projectile.id,
    targetId: selected.id,
    targetKind: selected.kind,
    weapon: "dual-turret",
    damage: projectile.damage,
    x: projectile.x,
    y: projectile.y,
  });
  finishProjectile(world, projectile, selected.kind === "player" ? "player-impact" : selected.kind === "boat" ? "boat-impact" : "target-impact", {
    targetId: selected.id,
    targetKind: selected.kind,
  });
  return true;
}

function boundaryReason(projectile) {
  if (projectile.x <= 0 || projectile.x >= 420 || projectile.y <= 0 || projectile.y >= 320) return "boundary-impact";
  return null;
}

export function stepDualTurretProjectiles(world, dt) {
  const state = stateFor(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  for (const projectile of state.projectiles) {
    if (projectile.endReason) continue;
    const from = {x: projectile.x, y: projectile.y};
    projectile.previousX = projectile.x;
    projectile.previousY = projectile.y;
    projectile.x += projectile.vx * safeDt;
    projectile.y += projectile.vy * safeDt;
    projectile.age += safeDt;
    projectile.ttl -= safeDt;
    const to = {x: projectile.x, y: projectile.y};
    if (hitCandidate(world, projectile, from, to)) continue;
    const reason = boundaryReason(projectile);
    if (reason) {
      finishProjectile(world, projectile, reason);
      continue;
    }
    if (projectile.ttl <= 0) finishProjectile(world, projectile, projectile.y <= 72 ? "ground-impact" : "water-impact");
  }
  state.projectiles = state.projectiles.filter(projectile => !projectile.endReason);
  return state.projectiles;
}

export function ensureDualTurretProjectileState(world) {
  return stateFor(world);
}
