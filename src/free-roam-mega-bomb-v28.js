"use strict";

import {dropCarriedCrate} from "../public/src/free-roam-activities.js?v=43";
import {applyCombatDamage} from "../public/src/free-roam-combat-v2.js?v=5";
import {damageEnemyBoat} from "../public/src/free-roam-enemy-boats.js?v=3";
import {damageHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js?v=3";
import {damageHostileActor, releaseCrewFromBoat} from "../public/src/free-roam-hostile-actors.js?v=2";
import {damageHostileGunner} from "../public/src/free-roam-hostile-gunners.js?v=32";
import {releaseStolenCargo} from "../public/src/free-roam-marauder.js?v=33";
import {damageEscort} from "../public/src/free-roam-pursuer-squad.js?v=33";
import {listCombatTargets, resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=35";
import {notifyThreatBoatDestroyed} from "../public/src/free-roam-threat-director.js?v=3";
import {
  MEGA_BOMB_LAND_RECT,
  MEGA_BOMB_WORLD_BOUNDS,
  bearing,
  clamp,
  createMegaBombProjectile,
  distancePointToSegment,
  pointInsideRect,
  sourceVelocity,
  speed3,
  stepMegaBombPhysics,
  surfaceAt,
} from "./free-roam-mega-bomb-physics-v1.js";

export const MEGA_BOMB_START_AMMO = 25;
export const MEGA_BOMB_MAX_AMMO = 25;
export const MEGA_BOMB_RADIUS = 38;
export const MEGA_BOMB_CORE_RADIUS = 10;
export const MEGA_BOMB_MAX_RANGE = 210;

const AMMO_VERSION = 5;
const PHYSICS_VERSION = 1;
const COOLDOWN = 1.15;
const ARM_SECONDS = 0.22;
const IMPACT_RADIUS = 3.1;
const LOW_FLIGHT_HEIGHT = 4.6;
const STUN_RADIUS = 25;

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function boatForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  return world.boats?.find(boat => boat?.id === player.activeBoat)
    || world.boats?.[player.activeBoat]
    || null;
}

function pointForPlayer(world, playerIndex) {
  return boatForPlayer(world, playerIndex) || world.players?.[playerIndex] || null;
}

function listenerVelocity(world, playerIndex) {
  const boat = boatForPlayer(world, playerIndex);
  return boat ? sourceVelocity(boat) : {vx: 0, vy: 0};
}

function segmentIntersectsRect(a, b, rect = MEGA_BOMB_LAND_RECT) {
  const x0 = Number(a?.x), y0 = Number(a?.y), x1 = Number(b?.x), y1 = Number(b?.y);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  let near = 0, far = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rect.minX, rect.maxX - x0, y0 - rect.minY, rect.maxY - y0];
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(p[index]) < 1e-9) {
      if (q[index] < 0) return false;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) near = Math.max(near, ratio);
    else far = Math.min(far, ratio);
    if (near > far) return false;
  }
  return true;
}

export function megaBombPathBlocked(source, target) {
  return !pointInsideRect(source) && !pointInsideRect(target)
    && segmentIntersectsRect(source, target);
}

function spatial(world, source) {
  const sourceSpeed = speed3(source);
  return (world.players || []).map((_, index) => {
    const listener = pointForPlayer(world, index);
    if (!listener || world.freeActivities?.presence?.[index] === false) {
      return {
        pan: 0, gain: 0, distance: 999, listenerX: null, listenerY: null,
        listenerHeading: 0, radialSpeed: 0, speed: sourceSpeed, elevation: 0,
        occluded: false, surface: surfaceAt(source),
      };
    }
    const horizontalMetres = distance(listener, source);
    const metres = Math.hypot(horizontalMetres, Math.max(0, Number(source.z) || 0));
    const relative = wrap(bearing(listener, source) - (Number(listener.heading) || 0));
    const listenerMotion = listenerVelocity(world, index);
    const dx = (Number(source.x) || 0) - (Number(listener.x) || 0);
    const dy = (Number(source.y) || 0) - (Number(listener.y) || 0);
    const length = Math.hypot(dx, dy) || 1;
    const relativeVx = (Number(source.vx) || 0) - listenerMotion.vx;
    const relativeVy = (Number(source.vy) || 0) - listenerMotion.vy;
    const radialSpeed = (relativeVx * dx + relativeVy * dy) / length;
    return {
      pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
      gain: clamp(1 - metres / 320, 0.02, 1),
      distance: Math.round(metres * 10) / 10,
      listenerX: Number(listener.x) || 0,
      listenerY: Number(listener.y) || 0,
      listenerHeading: Number(listener.heading) || 0,
      radialSpeed: Math.round(radialSpeed * 10) / 10,
      speed: Math.round(sourceSpeed * 10) / 10,
      elevation: Math.atan2(Math.max(0, Number(source.z) || 0), Math.max(0.1, horizontalMetres)) * 180 / Math.PI,
      occluded: megaBombPathBlocked(source, listener),
      surface: surfaceAt(source),
    };
  });
}

function upgradeLegacyProjectile(projectile) {
  if (Number(projectile?.physicsVersion) === PHYSICS_VERSION) return projectile;
  const vx = Number(projectile?.vx) || 0;
  const vy = Number(projectile?.vy) || 0;
  Object.assign(projectile, {
    physicsVersion: PHYSICS_VERSION,
    z: Math.max(0.5, Number(projectile?.z) || 2),
    vx,
    vy,
    vz: Number.isFinite(Number(projectile?.vz)) ? Number(projectile.vz) : 3.5,
    age: Math.max(0, Number(projectile?.age) || 0),
    maxAge: Math.max(2.5, Number(projectile?.maxAge) || (Number(projectile?.flightTime) || 2) + 1.5),
    intendedDistance: Math.max(20, Number(projectile?.pathDistance) || 100),
    intendedFlightTime: Math.max(1, Number(projectile?.flightTime) || 2),
    distanceTravelled: Math.max(0, Number(projectile?.distanceTravelled) || 0),
    energy: clamp(projectile?.energy ?? 0.7, 0.15, 1),
    bounces: Math.max(0, Math.floor(Number(projectile?.bounces) || 0)),
    armed: (Number(projectile?.age) || 0) >= ARM_SECONDS,
    nextFlightAt: Math.max(0, Number(projectile?.nextFlightAt) || 0),
    launchSpeed: Math.hypot(vx, vy),
  });
  return projectile;
}

export function ensureMegaBombState(world) {
  if (!world) return null;
  world.freeMegaBombs ||= {projectiles: [], nextId: 1, ammoVersion: AMMO_VERSION};
  const state = world.freeMegaBombs;
  if (!Array.isArray(state.projectiles)) state.projectiles = Object.values(state.projectiles || {});
  if (!Number.isFinite(Number(state.nextId))) state.nextId = 1;
  for (const projectile of state.projectiles) upgradeLegacyProjectile(projectile);
  const storedAmmoVersion = Number(state.ammoVersion);
  const migrateStock = !Number.isFinite(storedAmmoVersion) || storedAmmoVersion < AMMO_VERSION;
  for (const player of world.players || []) {
    if (!player?.combat) continue;
    player.combat.weapons ||= {};
    player.combat.weapons.megaBomb = true;
    const currentAmmo = Number(player.combat.megaBombAmmo);
    player.combat.megaBombAmmo = !Number.isFinite(currentAmmo) || migrateStock
      ? MEGA_BOMB_START_AMMO
      : clamp(currentAmmo, 0, MEGA_BOMB_MAX_AMMO);
    if (!Number.isFinite(Number(player.combat.megaBombCooldown))) player.combat.megaBombCooldown = 0;
  }
  state.ammoVersion = AMMO_VERSION;
  return state;
}

export function reportMegaBombStatus(world, playerIndex) {
  ensureMegaBombState(world);
  const remaining = Math.max(0, Math.floor(Number(world.players?.[playerIndex]?.combat?.megaBombAmmo) || 0));
  emit(world, "mega-bomb-status", "", [playerIndex], {sourcePlayer: playerIndex, remaining});
  return remaining;
}

function chosenTarget(world, playerIndex, origin) {
  const id = world.players?.[playerIndex]?.combat?.lockedTargetId;
  const locked = resolveCombatTarget(world, playerIndex, id, MEGA_BOMB_MAX_RANGE);
  if (locked?.point) {
    return {
      x: clamp(locked.point.x, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX),
      y: clamp(locked.point.y, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY),
      distance: clamp(distance(origin, locked.point), 18, MEGA_BOMB_MAX_RANGE),
      targetId: locked.id || id || null,
    };
  }
  const direction = sourceVelocity({heading: origin.heading, speed: 1});
  const fallbackDistance = 108;
  return {
    x: clamp(origin.x + direction.vx * fallbackDistance, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX),
    y: clamp(origin.y + direction.vy * fallbackDistance, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY),
    distance: fallbackDistance,
    targetId: null,
  };
}

export function launchMegaBomb(world, playerIndex) {
  const state = ensureMegaBombState(world);
  const player = world.players?.[playerIndex];
  const combat = player?.combat;
  const origin = pointForPlayer(world, playerIndex);
  if (!state || !origin || !combat?.alive || combat.knockedDown) return false;
  const remaining = Math.max(0, Math.floor(Number(combat.megaBombAmmo) || 0));
  if (world.freeActivities?.shopOpen?.[playerIndex]) {
    emit(world, "mega-bomb-denied", "Сначала закрой магазин.", [playerIndex], {remaining});
    return false;
  }
  if (world.freeContracts?.boardOpen?.[playerIndex]) {
    emit(world, "mega-bomb-denied", "Сначала закрой доску заказов.", [playerIndex], {remaining});
    return false;
  }
  if (state.projectiles.some(item => item.owner === playerIndex)) {
    emit(world, "mega-bomb-denied", "Предыдущая мега-бомба ещё летит.", [playerIndex], {remaining});
    return false;
  }
  if (combat.megaBombCooldown > 0 || remaining <= 0) {
    emit(world, "mega-bomb-denied", remaining
      ? "Пусковая система ещё перезаряжается."
      : "Мега-бомбы закончились. Новые заряды продаёт торговец.", [playerIndex], {remaining});
    return false;
  }

  const target = chosenTarget(world, playerIndex, origin);
  const heading = bearing(origin, target);
  const direction = sourceVelocity({heading, speed: 1});
  const start = {
    x: clamp(origin.x + direction.vx * 3.2, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX),
    y: clamp(origin.y + direction.vy * 3.2, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY),
    z: ["foot", "swim"].includes(player.mode) ? 1.9 : 2.35,
  };
  const sequence = state.nextId++;
  const launchBoat = boatForPlayer(world, playerIndex);
  const inheritedVelocity = launchBoat ? sourceVelocity(launchBoat) : {vx: 0, vy: 0};
  const projectile = createMegaBombProjectile({
    id: `mega-bomb-${sequence}`,
    owner: playerIndex,
    start,
    heading,
    intendedDistance: target.distance,
    inheritedVelocity,
  });
  Object.assign(projectile, {
    targetX: target.x,
    targetY: target.y,
    targetId: target.targetId,
    sourceBoatId: launchBoat?.id || null,
    sourceSpeed: Math.hypot(inheritedVelocity.vx, inheritedVelocity.vy),
  });
  state.projectiles.push(projectile);
  combat.megaBombAmmo = remaining - 1;
  combat.megaBombCooldown = COOLDOWN;
  emit(world, "mega-bomb-launch", "", [0, 1], {
    ...projectile,
    projectileId: projectile.id,
    speed: speed3(projectile),
    surface: surfaceAt(projectile),
    spatial: spatial(world, projectile),
  });
  emit(world, "mega-bomb-launched-status", `Мега-бомба запущена. Осталось ${combat.megaBombAmmo}.`, [playerIndex], {
    remaining: combat.megaBombAmmo,
  });
  return true;
}

function damageAt(metres, surface = "water") {
  const distanceValue = Math.max(0, Number(metres) || 0);
  let damage;
  if (distanceValue <= MEGA_BOMB_CORE_RADIUS) {
    damage = 150 + 65 * (1 - distanceValue / MEGA_BOMB_CORE_RADIUS);
  } else {
    const amount = clamp(1 - (distanceValue - MEGA_BOMB_CORE_RADIUS)
      / (MEGA_BOMB_RADIUS - MEGA_BOMB_CORE_RADIUS), 0, 1);
    damage = 10 + 140 * Math.pow(amount, 1.28);
  }
  return damage * (surface === "water" ? 1.06 : 1);
}

function blastOcclusion(blast, target) {
  return megaBombPathBlocked(blast, target) ? 0.18 : 1;
}

function pushEntity(entity, blast, impulse, boat = false) {
  if (!entity || entity.destroyed || entity.sunk) return;
  const angle = bearing(blast, entity) * Math.PI / 180;
  const displacement = impulse * (boat ? 0.012 : 0.027);
  entity.x = clamp(entity.x + Math.sin(angle) * displacement, MEGA_BOMB_WORLD_BOUNDS.minX, MEGA_BOMB_WORLD_BOUNDS.maxX);
  entity.y = clamp(entity.y - Math.cos(angle) * displacement, MEGA_BOMB_WORLD_BOUNDS.minY, MEGA_BOMB_WORLD_BOUNDS.maxY);
  if (boat) entity.speed = clamp((Number(entity.speed) || 0) + impulse * 0.026, -35, 35);
}

function helpers() {
  return {
    dropCarriedCrate,
    onEnemyBoatDestroyed(world, boat, sourcePlayer) {
      releaseCrewFromBoat(world, boat);
      notifyThreatBoatDestroyed(world, boat, sourcePlayer);
    },
  };
}

function damageEnemyTarget(world, target, damage, owner) {
  const helperSet = helpers();
  const wasDestroyed = Boolean(target.point?.destroyed);
  if (target.kind === "marauder") {
    const boat = target.point;
    boat.hull = clamp((Number(boat.hull) || 72) - damage, 0, 72);
    if (boat.hull <= 0) {
      releaseStolenCargo(world, boat);
      boat.destroyed = true;
      boat.active = false;
      boat.speed = 0;
      notifyThreatBoatDestroyed(world, boat, owner);
      emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен взрывом.", [0, 1], {
        sourcePlayer: owner, pursuerId: boat.id || "pursuer-1", x: boat.x, y: boat.y,
      });
    }
  } else if (target.kind === "escort") {
    damageEscort(world, target.pursuerId, damage, owner, helperSet, {weapon: "mega-bomb"});
  } else if (target.kind === "gunner") {
    damageHostileGunner(world, target.gunnerId, damage * 1.12, owner);
  } else if (["hostileActor", "elite"].includes(target.kind)) {
    damageHostileActor(world, target.actorId, damage * 1.18, owner, {weapon: "mega-bomb"});
  } else if (target.kind === "enemyBoat") {
    damageEnemyBoat(world, target.enemyBoatId, damage, owner, helperSet, {weapon: "mega-bomb"});
  }
  return !wasDestroyed && Boolean(target.point?.destroyed);
}

function damagePlayers(world, blast, projectile, surface) {
  let hitCount = 0;
  let deathCount = 0;
  let stunnedCount = 0;
  const presence = world.freeActivities?.presence || [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (presence[index] === false) continue;
    const player = world.players[index];
    const point = pointForPlayer(world, index);
    if (!player?.combat?.alive || !point) continue;
    const metres = distance(blast, point);
    if (metres > MEGA_BOMB_RADIUS) continue;
    const multiplier = blastOcclusion(blast, point);
    const damage = damageAt(metres, surface) * multiplier * 0.82;
    if (damage <= 1) continue;
    const wasAlive = player.combat.alive;
    const wasKnockedDown = player.combat.knockedDown;
    const attackerIndex = index === projectile.owner ? -1 : projectile.owner;
    applyCombatDamage(world, index, damage, attackerIndex, {
      weapon: "mega-bomb",
      heavy: true,
      eventType: "mega-bomb-player-hit",
      sourcePoint: blast,
    }, helpers());
    player.combat.stun = clamp((Number(player.combat.stun) || 0) + damage * 0.6, 0, 100);
    if (player.combat.alive && metres <= STUN_RADIUS) {
      player.combat.knockedDown = true;
      player.combat.knockdownRemaining = Math.max(
        Number(player.combat.knockdownRemaining) || 0,
        clamp(1.1 + damage / 55, 1.2, 4.8),
      );
      if (!wasKnockedDown) {
        stunnedCount += 1;
        emit(world, "mega-bomb-stun", "", [index], {
          sourcePlayer: projectile.owner,
          targetPlayer: index,
          projectileId: projectile.id,
          x: point.x,
          y: point.y,
          damage: Math.round(damage),
        });
        emit(world, "mega-bomb-stun-notice", "Ударная волна сбила тебя с ног.", [index], {
          sourcePlayer: projectile.owner,
          targetPlayer: index,
          projectileId: projectile.id,
        });
      }
    }
    if (!["boat", "roof"].includes(player.mode)) pushEntity(player, blast, damage, false);
    if (wasAlive && !player.combat.alive) deathCount += 1;
    hitCount += 1;
  }
  return {hitCount, deathCount, stunnedCount};
}

function boatAudience(world, boat) {
  const result = [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (boatForPlayer(world, index)?.id === boat.id || world.players[index]?.activeBoat === boat.id) result.push(index);
  }
  return result;
}

function damagePlayerBoats(world, blast, projectile, surface) {
  let hitCount = 0;
  let disabledCount = 0;
  for (const boat of world.boats || []) {
    if (!boat || boat.sunk || !Number.isFinite(Number(boat.x)) || !Number.isFinite(Number(boat.y))) continue;
    const metres = distance(blast, boat);
    if (metres > MEGA_BOMB_RADIUS) continue;
    const multiplier = blastOcclusion(blast, boat);
    const raw = damageAt(metres, surface) * multiplier;
    const hullDamage = raw * 0.55;
    const oldHull = Number(boat.hull) || 0;
    boat.hull = clamp(oldHull - hullDamage, 0, 100);
    boat.leak = clamp((Number(boat.leak) || 0) + raw * 0.045, 0, 24);
    boat.water = clamp((Number(boat.water) || 0) + raw * 0.08, 0, 100);
    pushEntity(boat, blast, raw, true);
    const audience = boatAudience(world, boat);
    emit(world, "mega-bomb-boat-hit", "", audience.length ? audience : [0, 1], {
      sourcePlayer: projectile.owner,
      projectileId: projectile.id,
      boatId: boat.id,
      damage: Math.round(hullDamage),
      hull: boat.hull,
      water: boat.water,
      x: boat.x,
      y: boat.y,
    });
    if (oldHull > 0 && boat.hull <= 0) disabledCount += 1;
    hitCount += 1;
  }
  return {hitCount, disabledCount};
}

function damageEnemies(world, blast, projectile, surface) {
  let hitCount = 0;
  let destroyedCount = 0;
  let heavyDamage = 0;
  let blockedCount = 0;
  const unique = new Map();
  for (const target of listCombatTargets(world, projectile.owner, Infinity)) {
    if (["player", "boat", "heavyHull", "heavyEngine", "heavyTurret"].includes(target.kind)) continue;
    if (!unique.has(target.id)) unique.set(target.id, target);
  }
  for (const target of unique.values()) {
    const metres = distance(blast, target.point);
    if (metres > MEGA_BOMB_RADIUS) continue;
    const multiplier = blastOcclusion(blast, target.point);
    if (multiplier < 0.5) blockedCount += 1;
    const damage = damageAt(metres, surface) * multiplier;
    if (damage <= 1) continue;
    if (damageEnemyTarget(world, target, damage, projectile.owner)) destroyedCount += 1;
    pushEntity(target.point, blast, damage, ["marauder", "escort", "enemyBoat"].includes(target.kind));
    hitCount += 1;
  }

  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && distance(blast, heavy) <= MEGA_BOMB_RADIUS) {
    const multiplier = blastOcclusion(blast, heavy);
    if (multiplier < 0.5) blockedCount += 1;
    const damage = damageAt(distance(blast, heavy), surface) * multiplier;
    const before = heavy.destroyed;
    damageHeavyPursuer(world, "turret", damage * 1.25, projectile.owner, helpers(), {weapon: "mega-bomb"});
    damageHeavyPursuer(world, "engine", damage * 0.72, projectile.owner, helpers(), {weapon: "mega-bomb"});
    damageHeavyPursuer(world, "hull", damage * 0.82, projectile.owner, helpers(), {weapon: "mega-bomb"});
    heavyDamage = Math.round(damage * 2.79);
    if (!before && heavy.destroyed) destroyedCount += 1;
    pushEntity(heavy, blast, damage, true);
    hitCount += 1;
  }
  return {hitCount, destroyedCount, heavyDamage, blockedCount};
}

function explode(world, projectile, reason, explicitSurface = null) {
  const blast = {x: projectile.x, y: projectile.y, z: Math.max(0, projectile.z), vx: 0, vy: 0, vz: 0};
  const surface = explicitSurface || surfaceAt(projectile);
  const playerResult = damagePlayers(world, blast, projectile, surface);
  const boatResult = damagePlayerBoats(world, blast, projectile, surface);
  const enemyResult = damageEnemies(world, blast, projectile, surface);
  const totalHits = playerResult.hitCount + boatResult.hitCount + enemyResult.hitCount;
  const text = totalHits
    ? `Взрыв поразил объектов: ${totalHits}. Противников уничтожено: ${enemyResult.destroyedCount}.`
    : enemyResult.blockedCount
      ? "Твёрдый берег ослабил ударную волну."
      : "Взрыв не задел цели.";
  emit(world, "mega-bomb-explosion", text, [0, 1], {
    sourcePlayer: projectile.owner,
    projectileId: projectile.id,
    reason,
    surface,
    x: projectile.x,
    y: projectile.y,
    z: Math.max(0, projectile.z),
    radius: MEGA_BOMB_RADIUS,
    hitCount: totalHits,
    playerHitCount: playerResult.hitCount,
    playerDeathCount: playerResult.deathCount,
    stunnedCount: playerResult.stunnedCount,
    boatHitCount: boatResult.hitCount,
    disabledBoatCount: boatResult.disabledCount,
    destroyedCount: enemyResult.destroyedCount,
    blockedCount: enemyResult.blockedCount,
    heavyDamage: enemyResult.heavyDamage,
    speed: speed3(projectile),
    energy: projectile.energy,
    bounces: projectile.bounces,
    spatial: spatial(world, blast),
  });
}

function potentialImpactTargets(world, projectile) {
  const result = [];
  const presence = world.freeActivities?.presence || [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (presence[index] === false || !world.players[index]?.combat?.alive) continue;
    const point = pointForPlayer(world, index);
    if (point) result.push({kind: "player", playerIndex: index, point});
  }
  for (const boat of world.boats || []) {
    if (boat && !boat.sunk) result.push({kind: "boat", point: boat, boatId: boat.id});
  }
  for (const target of listCombatTargets(world, projectile.owner, Infinity)) {
    if (["player", "boat"].includes(target.kind)) continue;
    result.push(target);
  }
  return result;
}

function impactReason(world, projectile, previous) {
  if (!projectile.armed || projectile.age < ARM_SECONDS || projectile.z > LOW_FLIGHT_HEIGHT) return null;
  for (const target of potentialImpactTargets(world, projectile)) {
    if (!target?.point || target.point.destroyed || target.point.sunk) continue;
    const closest = distancePointToSegment(target.point, previous, projectile);
    if (closest > IMPACT_RADIUS) continue;
    if (megaBombPathBlocked(projectile, target.point)) continue;
    if (target.kind === "player" && target.playerIndex === projectile.owner) return "self-impact";
    return "target-impact";
  }
  return null;
}

function returningDanger(world, projectile) {
  const owner = pointForPlayer(world, projectile.owner);
  if (!owner) return false;
  const dx = owner.x - projectile.x;
  const dy = owner.y - projectile.y;
  const speedSquared = projectile.vx * projectile.vx + projectile.vy * projectile.vy;
  if (speedSquared < 1) return false;
  const time = clamp((dx * projectile.vx + dy * projectile.vy) / speedSquared, 0, 2.5);
  const closest = Math.hypot(dx - projectile.vx * time, dy - projectile.vy * time);
  return time > 0.05 && closest <= MEGA_BOMB_RADIUS * 0.7;
}

export function stepMegaBombs(world, dt) {
  const state = ensureMegaBombState(world);
  const seconds = clamp(dt, 0, 0.1);
  for (const player of world.players || []) {
    if (player?.combat) player.combat.megaBombCooldown = Math.max(0, player.combat.megaBombCooldown - seconds);
  }
  const survivors = [];
  for (const projectile of state.projectiles) {
    upgradeLegacyProjectile(projectile);
    const result = stepMegaBombPhysics(projectile, seconds);
    if (result.ricochet) {
      emit(world, "mega-bomb-ricochet", "", [0, 1], {
        ...projectile,
        projectileId: projectile.id,
        reason: result.reason,
        surface: result.surface,
        speed: speed3(projectile),
        spatial: spatial(world, projectile),
      });
      if (returningDanger(world, projectile)) {
        emit(world, "mega-bomb-return-warning", "Рикошет. Мега-бомба возвращается в твою сторону.", [projectile.owner], {
          sourcePlayer: projectile.owner,
          projectileId: projectile.id,
        });
      }
    }

    const collisionReason = impactReason(world, projectile, result.previous);
    if (collisionReason) {
      explode(world, projectile, collisionReason, result.surface);
      continue;
    }
    if (result.terminal) {
      explode(world, projectile, result.reason, result.surface);
      continue;
    }
    if (projectile.age >= projectile.nextFlightAt) {
      projectile.nextFlightAt = projectile.age + 0.08;
      emit(world, "mega-bomb-flight", "", [0, 1], {
        ...projectile,
        projectileId: projectile.id,
        progress: clamp(projectile.age / projectile.maxAge, 0, 1),
        speed: speed3(projectile),
        surface: result.surface,
        spatial: spatial(world, projectile),
      });
    }
    survivors.push(projectile);
  }
  state.projectiles = survivors;
}

export function megaBombStatus(world) {
  const state = ensureMegaBombState(world);
  return {
    projectiles: state.projectiles.map(({
      id, owner, x, y, z, vx, vy, vz, age, maxAge, energy, bounces,
      targetX, targetY, sourceSpeed, distanceTravelled,
    }) => ({
      id, owner, x, y, z, vx, vy, vz, age, maxAge, energy, bounces,
      targetX, targetY, sourceSpeed, distanceTravelled,
    })),
    ammo: (world.players || []).map(player => Math.max(0, Math.floor(Number(player?.combat?.megaBombAmmo) || 0))),
  };
}
