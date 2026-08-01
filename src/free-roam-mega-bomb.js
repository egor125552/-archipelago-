"use strict";

import {damageEnemyBoat} from "../public/src/free-roam-enemy-boats.js?v=3";
import {damageHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js?v=3";
import {damageHostileActor, releaseCrewFromBoat} from "../public/src/free-roam-hostile-actors.js?v=2";
import {damageHostileGunner} from "../public/src/free-roam-hostile-gunners.js?v=32";
import {releaseStolenCargo} from "../public/src/free-roam-marauder.js?v=33";
import {damageEscort} from "../public/src/free-roam-pursuer-squad.js?v=33";
import {listCombatTargets, resolveCombatTarget} from "../public/src/free-roam-targeting.js?v=35";
import {notifyThreatBoatDestroyed} from "../public/src/free-roam-threat-director.js?v=3";

export const MEGA_BOMB_START_AMMO = 50;
export const MEGA_BOMB_RADIUS = 31;
export const MEGA_BOMB_CORE_RADIUS = 9.5;
export const MEGA_BOMB_MAX_RANGE = 145;

const AMMO_VERSION = 2;
const SPEED = 54;
const COOLDOWN = 1.25;
const PROXIMITY = 4.8;
const MIN_X = 4, MAX_X = 416, MIN_Y = 4, MAX_Y = 316;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (a, b) => Math.atan2((Number(b?.x) || 0) - (Number(a?.x) || 0), -((Number(b?.y) || 0) - (Number(a?.y) || 0))) * 180 / Math.PI;

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function pointForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  return ["boat", "roof"].includes(player.mode)
    ? world.boats?.find(boat => boat?.id === player.activeBoat) || player
    : player;
}

function spatial(world, source) {
  return (world.players || []).map((_, index) => {
    const listener = pointForPlayer(world, index);
    if (!listener || world.freeActivities?.presence?.[index] === false) {
      return {pan: 0, gain: 0, distance: 999, listenerX: null, listenerY: null, listenerHeading: 0};
    }
    const metres = distance(listener, source);
    const relative = wrap(bearing(listener, source) - (Number(listener.heading) || 0));
    return {
      pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
      gain: clamp(1 - metres / 280, 0.035, 1),
      distance: Math.round(metres * 10) / 10,
      listenerX: Number(listener.x) || 0,
      listenerY: Number(listener.y) || 0,
      listenerHeading: Number(listener.heading) || 0,
    };
  });
}

export function ensureMegaBombState(world) {
  if (!world) return null;
  world.freeMegaBombs ||= {projectiles: [], nextId: 1, ammoVersion: AMMO_VERSION};
  const state = world.freeMegaBombs;
  if (!Array.isArray(state.projectiles)) state.projectiles = Object.values(state.projectiles || {});
  if (!Number.isFinite(Number(state.nextId))) state.nextId = 1;
  const storedAmmoVersion = Number(state.ammoVersion);
  const upgradeOldTestAmmo = !Number.isFinite(storedAmmoVersion) || storedAmmoVersion < AMMO_VERSION;
  for (const player of world.players || []) {
    if (!player?.combat) continue;
    player.combat.weapons ||= {};
    player.combat.weapons.megaBomb = true;
    const currentAmmo = Number(player.combat.megaBombAmmo);
    if (!Number.isFinite(currentAmmo)) player.combat.megaBombAmmo = MEGA_BOMB_START_AMMO;
    else if (upgradeOldTestAmmo && currentAmmo <= 10) player.combat.megaBombAmmo = MEGA_BOMB_START_AMMO;
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
  if (locked?.point) return locked.point;
  const angle = (Number(origin.heading) || 0) * Math.PI / 180;
  return {x: clamp(origin.x + Math.sin(angle) * 92, MIN_X, MAX_X), y: clamp(origin.y - Math.cos(angle) * 92, MIN_Y, MAX_Y)};
}

export function launchMegaBomb(world, playerIndex) {
  const state = ensureMegaBombState(world);
  const player = world.players?.[playerIndex];
  const combat = player?.combat;
  const origin = pointForPlayer(world, playerIndex);
  if (!state || !origin || !combat?.alive || combat.knockedDown) return false;
  const remaining = Math.max(0, Math.floor(Number(combat.megaBombAmmo) || 0));
  if (state.projectiles.some(item => item.owner === playerIndex)) {
    emit(world, "mega-bomb-denied", "Предыдущая мега-бомба ещё летит.", [playerIndex], {remaining});
    return false;
  }
  if (combat.megaBombCooldown > 0 || remaining <= 0) {
    emit(world, "mega-bomb-denied", remaining ? "Пусковая система ещё перезаряжается." : "Мега-бомбы закончились.", [playerIndex], {remaining});
    return false;
  }
  const target = chosenTarget(world, playerIndex, origin);
  const heading = bearing(origin, target);
  const angle = heading * Math.PI / 180;
  const flightTime = clamp(distance(origin, target) / SPEED, 0.7, 2.75);
  const projectile = {
    id: `mega-bomb-${state.nextId++}`,
    owner: playerIndex,
    x: clamp(origin.x + Math.sin(angle) * 3.2, MIN_X, MAX_X),
    y: clamp(origin.y - Math.cos(angle) * 3.2, MIN_Y, MAX_Y),
    z: 1.5,
    heading,
    vx: Math.sin(angle) * SPEED,
    vy: -Math.cos(angle) * SPEED,
    age: 0,
    flightTime,
    nextFlightAt: 0,
  };
  state.projectiles.push(projectile);
  combat.megaBombAmmo = remaining - 1;
  combat.megaBombCooldown = COOLDOWN;
  emit(world, "mega-bomb-launch", "", [0, 1], {...projectile, projectileId: projectile.id, spatial: spatial(world, projectile)});
  emit(world, "mega-bomb-launched-status", `Мега-бомба запущена. Осталось ${combat.megaBombAmmo}.`, [playerIndex], {remaining: combat.megaBombAmmo});
  return true;
}

function damageAt(metres) {
  if (metres <= MEGA_BOMB_CORE_RADIUS) return 172 + 36 * (1 - metres / MEGA_BOMB_CORE_RADIUS);
  const amount = clamp(1 - (metres - MEGA_BOMB_CORE_RADIUS) / (MEGA_BOMB_RADIUS - MEGA_BOMB_CORE_RADIUS), 0, 1);
  return 24 + 148 * Math.pow(amount, 1.18);
}

function push(entity, blast, damage, boat = false) {
  if (!entity || entity.destroyed) return;
  const heading = bearing(blast, entity);
  const angle = heading * Math.PI / 180;
  const amount = damage * (boat ? 0.012 : 0.032);
  entity.x = clamp(entity.x + Math.sin(angle) * amount, MIN_X, MAX_X);
  entity.y = clamp(entity.y - Math.cos(angle) * amount, MIN_Y, MAX_Y);
  if (boat) entity.speed = Math.max(Number(entity.speed) || 0, damage * 0.025);
}

function helpers() {
  return {
    onEnemyBoatDestroyed(world, boat, sourcePlayer) {
      releaseCrewFromBoat(world, boat);
      notifyThreatBoatDestroyed(world, boat, sourcePlayer);
    },
  };
}

function damageTarget(world, target, damage, owner) {
  const h = helpers();
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
    }
    push(boat, target.point, damage, true);
  } else if (target.kind === "escort") damageEscort(world, target.pursuerId, damage, owner, h);
  else if (target.kind === "gunner") damageHostileGunner(world, target.gunnerId, damage * 1.12, owner);
  else if (["hostileActor", "elite"].includes(target.kind)) damageHostileActor(world, target.actorId, damage * 1.18, owner, {weapon: "mega-bomb"});
  else if (target.kind === "enemyBoat") damageEnemyBoat(world, target.enemyBoatId, damage, owner, h, {weapon: "mega-bomb"});
  return !wasDestroyed && Boolean(target.point?.destroyed);
}

function explode(world, projectile, reason) {
  const blast = {x: projectile.x, y: projectile.y};
  let hitCount = 0;
  let destroyedCount = 0;
  let heavyDamage = 0;
  const unique = new Map();
  for (const target of listCombatTargets(world, projectile.owner, Infinity)) {
    if (["player", "boat", "heavyHull", "heavyEngine", "heavyTurret"].includes(target.kind)) continue;
    if (!unique.has(target.id)) unique.set(target.id, target);
  }
  for (const target of unique.values()) {
    const metres = distance(blast, target.point);
    if (metres > MEGA_BOMB_RADIUS) continue;
    const damage = damageAt(metres);
    if (damageTarget(world, target, damage, projectile.owner)) destroyedCount += 1;
    push(target.point, blast, damage, ["marauder", "escort", "enemyBoat"].includes(target.kind));
    hitCount += 1;
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && distance(blast, heavy) <= MEGA_BOMB_RADIUS) {
    const damage = damageAt(distance(blast, heavy));
    const before = heavy.destroyed;
    damageHeavyPursuer(world, "turret", damage * 1.12, projectile.owner, helpers(), {weapon: "mega-bomb"});
    damageHeavyPursuer(world, "engine", damage * 0.66, projectile.owner, helpers(), {weapon: "mega-bomb"});
    damageHeavyPursuer(world, "hull", damage * 0.72, projectile.owner, helpers(), {weapon: "mega-bomb"});
    heavyDamage = Math.round(damage * 2.5);
    if (!before && heavy.destroyed) destroyedCount += 1;
    push(heavy, blast, damage, true);
    hitCount += 1;
  }
  const text = hitCount
    ? `Взрыв поразил целей: ${hitCount}. Уничтожено: ${destroyedCount}.`
    : "Взрыв не задел противников.";
  emit(world, "mega-bomb-explosion", text, [0, 1], {
    sourcePlayer: projectile.owner,
    projectileId: projectile.id,
    reason,
    x: projectile.x,
    y: projectile.y,
    z: 0,
    radius: MEGA_BOMB_RADIUS,
    hitCount,
    destroyedCount,
    heavyDamage,
    spatial: spatial(world, projectile),
  });
}

export function stepMegaBombs(world, dt) {
  const state = ensureMegaBombState(world);
  const seconds = clamp(dt, 0, 0.1);
  for (const player of world.players || []) {
    if (player?.combat) player.combat.megaBombCooldown = Math.max(0, player.combat.megaBombCooldown - seconds);
  }
  const survivors = [];
  for (const projectile of state.projectiles) {
    projectile.age += seconds;
    projectile.x += projectile.vx * seconds;
    projectile.y += projectile.vy * seconds;
    const progress = clamp(projectile.age / projectile.flightTime, 0, 1);
    projectile.z = 1.5 + Math.sin(progress * Math.PI) * 14;
    if (projectile.age >= projectile.nextFlightAt) {
      projectile.nextFlightAt = projectile.age + 0.12;
      emit(world, "mega-bomb-flight", "", [0, 1], {...projectile, projectileId: projectile.id, progress, spatial: spatial(world, projectile)});
    }
    const near = projectile.age >= 0.22 && listCombatTargets(world, projectile.owner, Infinity)
      .some(target => !["player", "boat"].includes(target.kind) && distance(projectile, target.point) <= PROXIMITY);
    const outside = projectile.x < MIN_X || projectile.x > MAX_X || projectile.y < MIN_Y || projectile.y > MAX_Y;
    if (near || projectile.age >= projectile.flightTime || outside) {
      explode(world, projectile, near ? "proximity" : outside ? "boundary" : "target");
    } else survivors.push(projectile);
  }
  state.projectiles = survivors;
}

export function megaBombStatus(world) {
  const state = ensureMegaBombState(world);
  return {
    projectiles: state.projectiles.map(({id, owner, x, y, z, age, flightTime}) => ({id, owner, x, y, z, age, flightTime})),
    ammo: (world.players || []).map(player => Math.max(0, Math.floor(Number(player?.combat?.megaBombAmmo) || 0))),
  };
}
