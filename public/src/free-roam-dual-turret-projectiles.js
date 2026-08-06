"use strict";

import {applyBoatDamage} from "./collision-model.js";
import {applyCombatDamage} from "./free-roam-combat-v2.js?v=6";
import {damageEnemyBoat} from "./free-roam-enemy-boats.js?v=3";
import {damageEscort} from "./free-roam-pursuer-squad.js?v=33";
import {damageHostileGunner} from "./free-roam-hostile-gunners.js?v=32";
import {damageHostileActor} from "./free-roam-hostile-actors.js?v=3";
import {damageHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=4";
import {damageEliteBoatBoss} from "./free-roam-elite-boat.js?v=2";
import {releaseStolenCargo} from "./free-roam-marauder.js?v=33";
import {DUAL_TURRET_SHOT_DAMAGE} from "./free-roam-dual-turret-config.js?v=3";

const rad = value => Number(value) * Math.PI / 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function stateFor(world) {
  world.freeDualTurretProjectiles ||= {nextId: 1, projectiles: [], endEvents: [], mode: "instant"};
  const state = world.freeDualTurretProjectiles;
  if (!Array.isArray(state.projectiles)) state.projectiles = [];
  if (!Array.isArray(state.endEvents)) state.endEvents = [];
  if (!Number.isInteger(state.nextId)) state.nextId = 1;
  state.mode = "instant";
  return state;
}

function muzzlePoint(boat, turret) {
  const direction = rad(boat?.heading || 0);
  const side = Number(turret?.side) || 0;
  const forward = 4.6;
  const lateral = 4.2 * side;
  return {
    x: Number(boat?.x) + Math.sin(direction) * forward + Math.cos(direction) * lateral,
    y: Number(boat?.y) - Math.cos(direction) * forward + Math.sin(direction) * lateral,
  };
}

function finishShot(world, shot, reason, target = null) {
  const state = stateFor(world);
  const end = {
    id: shot.id,
    reason,
    x: Number(target?.point?.x ?? shot.impactX ?? shot.x),
    y: Number(target?.point?.y ?? shot.impactY ?? shot.y),
    sourcePlayer: shot.sourcePlayer,
    targetId: target?.id ?? null,
    targetKind: target?.kind ?? null,
    instant: true,
    at: world.time,
  };
  state.endEvents.push(end);
  if (state.endEvents.length > 24) state.endEvents.splice(0, state.endEvents.length - 24);
  emit(world, "dual-turret-projectile-end", "", [0, 1], end);
  return end;
}

function destroyMarauder(world, target, sourcePlayer) {
  const marauder = target?.point;
  if (!marauder || marauder.destroyed) return false;
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
  return true;
}

function applyTargetDamage(world, target, shot) {
  const amount = shot.damage;
  const sourcePlayer = shot.sourcePlayer;
  if (target.kind === "player") {
    return applyCombatDamage(world, target.playerIndex, amount, sourcePlayer, {
      weapon: "dual-turret",
      heavy: true,
      eventType: "dual-turret-player-hit",
      sourcePoint: shot,
    }, {});
  }
  if (target.kind === "boat") return applyBoatDamage(target.point, amount, {armorShare: 0.72, leakShare: 0.045}).damage > 0;
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

export function fireDualTurretHitscan(world, {boat, turret, sourcePlayer, heading, target}) {
  const state = stateFor(world);
  const muzzle = muzzlePoint(boat, turret);
  const impactX = Number(target?.point?.x) || muzzle.x;
  const impactY = Number(target?.point?.y) || muzzle.y;
  const shot = {
    id: `dual-shot-${state.nextId++}`,
    turretId: turret.id,
    sourcePlayer,
    sourceBoatId: boat.id,
    targetId: target?.id ?? null,
    x: muzzle.x,
    y: muzzle.y,
    impactX,
    impactY,
    heading,
    damage: DUAL_TURRET_SHOT_DAMAGE,
    instant: true,
  };
  const applied = Boolean(target && applyTargetDamage(world, target, shot));
  if (target) {
    emit(world, "dual-turret-hit", "", [0, 1], {
      sourcePlayer,
      projectileId: shot.id,
      targetId: target.id,
      targetKind: target.kind,
      weapon: "dual-turret",
      damage: shot.damage,
      applied,
      instant: true,
      x: impactX,
      y: impactY,
    });
  }
  finishShot(world, shot, target ? (target.kind === "player" ? "player-impact" : target.kind === "boat" ? "boat-impact" : "target-impact") : "no-target", target);
  return shot;
}

export function spawnDualTurretProjectile(world, options) {
  return fireDualTurretHitscan(world, {...options, target: options?.target || null});
}

export function stepDualTurretProjectiles(world) {
  const state = stateFor(world);
  if (state.projectiles.length) {
    for (const legacy of state.projectiles) {
      finishShot(world, {
        id: legacy.id || `legacy-dual-shot-${state.nextId++}`,
        sourcePlayer: legacy.sourcePlayer,
        x: legacy.x,
        y: legacy.y,
      }, "legacy-cleared");
    }
    state.projectiles = [];
  }
  return state.projectiles;
}

export function ensureDualTurretProjectileState(world) {
  const state = stateFor(world);
  if (state.projectiles.length) stepDualTurretProjectiles(world);
  return state;
}
