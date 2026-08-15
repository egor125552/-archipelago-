"use strict";

import {vesselLocalToWorld} from "../vessel-interior.js";
import {applyVesselDamage} from "../vessel-damage.js";
import {listCombatTargets, resolveCombatTarget} from "../../free-roam-targeting.js?v=39";
import {applyBoatDamage} from "../../collision-model.js";
import {applyCombatDamage} from "../../free-roam-combat-v2.js?v=6";
import {spawnRareCrate} from "../../free-roam-activities.js?v=44";
import {damageEnemyBoat} from "../../free-roam-enemy-boats.js?v=3";
import {damageEscort} from "../../free-roam-pursuer-squad.js?v=33";
import {damageHostileGunner} from "../../free-roam-hostile-gunners.js?v=32";
import {damageHostileActor, releaseCrewFromBoat} from "../../free-roam-hostile-actors.js?v=3";
import {damageHeavyPursuer} from "../../free-roam-heavy-pursuer.js?v=4";
import {damageEliteBoatBoss} from "../../free-roam-elite-boat.js?v=2";
import {notifyThreatBoatDestroyed} from "../../free-roam-threat-director.js?v=4";
import {releaseStolenCargo} from "../../free-roam-marauder.js?v=33";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const rad = value => Number(value) * Math.PI / 180;
const wrapDeg = value => ((Number(value || 0) + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

const MOUNTED_ENEMY_BOAT_HELPERS = Object.freeze({
  spawnRareCrate,
  onEnemyBoatDestroyed(world, boat, sourcePlayer) {
    releaseCrewFromBoat(world, boat);
    notifyThreatBoatDestroyed(world, boat, sourcePlayer);
  },
});

function currentInput(world, playerIndex) {
  return {
    ...(world?.freeActivities?.inputs?.[playerIndex] || {}),
    ...(world?.operationInputs?.[playerIndex] || {}),
    ...(world?.inputs?.[playerIndex] || {}),
  };
}

function targetAllowed(world, sourceBoat, target) {
  if (!target) return false;
  if (target.kind === "boat" && target.boatId === sourceBoat.id) return false;
  if (target.kind === "player" && world.players?.[target.playerIndex]?.activeBoat === sourceBoat.id) return false;
  return true;
}

function selectTarget(world, playerIndex, boat, range) {
  const combat = world.players?.[playerIndex]?.combat;
  const locked = resolveCombatTarget(world, playerIndex, combat?.lockedTargetId, range);
  if (locked && targetAllowed(world, boat, locked)) return locked;
  if (combat?.lockedTargetId) combat.lockedTargetId = null;
  const automatic = listCombatTargets(world, playerIndex, range)
    .find(target => targetAllowed(world, boat, target) && !["player", "boat"].includes(target.kind)) || null;
  if (automatic && combat) combat.lockedTargetId = automatic.id;
  return automatic;
}

function targetBearing(from, target) {
  return Math.atan2((Number(target?.x) || 0) - (Number(from?.x) || 0), -((Number(target?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
}

function emptyImpact(source, heading, range) {
  const direction = rad(heading);
  return {
    x: Number(source.x) + Math.sin(direction) * range,
    y: Number(source.y) - Math.cos(direction) * range,
  };
}

function mountedWeapons(entry) {
  const result = [];
  for (const definition of entry?.definition?.modules || []) {
    if (definition?.type !== "mounted-weapon") continue;
    if (definition?.config?.runtimeSystem !== "station-hitscan-v1") continue;
    const state = entry.instance?.modules?.[definition.id];
    if (state) result.push({definition, state});
  }
  return result;
}

function weaponStation(entry, mounted) {
  const configuredResource = String(mounted?.definition?.config?.stationResourceId || "");
  for (const deck of entry?.definition?.decks || []) {
    for (const object of deck.objects || []) {
      if (object?.kind !== "station") continue;
      const resourceId = String(object.resourceId || object.id);
      if (object.controlsModule === mounted.definition.id || (configuredResource && resourceId === configuredResource)) {
        return {deck, object, resourceId};
      }
    }
  }
  return null;
}

function weaponOperator(entry, mounted) {
  const station = weaponStation(entry, mounted);
  if (!station) return null;
  const owner = entry?.instance?.interior?.claims?.[station.resourceId];
  if (!Number.isInteger(owner) || !entry.instance?.occupants?.[owner]) return null;
  return {playerIndex: owner, station};
}

function weaponSourcePoint(entry, mounted) {
  const mountId = mounted?.definition?.mounts?.[0];
  const mount = (entry?.definition?.mounts || []).find(candidate => candidate.id === mountId);
  if (!mount?.position) return {x: Number(entry?.boat?.x) || 0, y: Number(entry?.boat?.y) || 0};
  return vesselLocalToWorld(entry.boat, mount.position);
}

function operatorInput(entry, world, playerIndex) {
  const captured = entry?.instance?.interior?.walkableControl?.inputs?.[String(playerIndex)];
  return captured ? {...captured} : currentInput(world, playerIndex);
}

function destroyMarauder(world, target, sourcePlayer, weapon, label) {
  const marauder = target?.point;
  if (!marauder || marauder.destroyed) return false;
  releaseStolenCargo(world, marauder);
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  marauder.respawnAt = 0;
  emit(world, "pursuer-destroyed", `Катер-преследователь уничтожен: ${label}. Остался редкий ящик.`, [0, 1], {
    sourcePlayer,
    weapon,
    x: marauder.x,
    y: marauder.y,
  });
  MOUNTED_ENEMY_BOAT_HELPERS.spawnRareCrate(world, marauder.x, marauder.y, "valuable", "pursuer");
  MOUNTED_ENEMY_BOAT_HELPERS.onEnemyBoatDestroyed(world, marauder, sourcePlayer);
  return true;
}

function incomingSide(targetBoat, sourcePoint) {
  const absolute = Math.atan2(
    (Number(sourcePoint?.x) || 0) - (Number(targetBoat?.x) || 0),
    -((Number(sourcePoint?.y) || 0) - (Number(targetBoat?.y) || 0)),
  ) * 180 / Math.PI;
  const relative = Math.abs(wrapDeg(absolute - (Number(targetBoat?.heading) || 0)));
  if (relative <= 60) return "front";
  if (relative >= 120) return "rear";
  return "side";
}

function damageableModuleForZone(targetEntry, zoneId) {
  if (!zoneId) return null;
  const damageConfig = targetEntry.definition?.damage || {};
  const choices = Array.isArray(damageConfig.zoneModuleChoices?.[zoneId])
    ? damageConfig.zoneModuleChoices[zoneId]
    : [];
  const valid = choices.filter(moduleId => targetEntry.instance?.modules?.[moduleId]);
  if (valid.length) {
    // Prefer the healthiest live component. This spreads repeated compartment
    // impacts across real machinery without a transient random/cursor state
    // that could be reset by reconnecting to change the result.
    valid.sort((leftId, rightId) => {
      const left = Number(targetEntry.instance.modules[leftId]?.health);
      const right = Number(targetEntry.instance.modules[rightId]?.health);
      const leftHealth = Number.isFinite(left) ? left : 100;
      const rightHealth = Number.isFinite(right) ? right : 100;
      return rightHealth - leftHealth;
    });
    return valid[0];
  }
  const configured = damageConfig.zoneModules?.[zoneId];
  return configured && targetEntry.instance?.modules?.[configured] ? configured : null;
}

function zonalBoatDamage(context, targetEntry, amount, sourcePoint, config) {
  const damageConfig = targetEntry.definition?.damage || {};
  const side = incomingSide(targetEntry.boat, sourcePoint);
  const zoneId = damageConfig.directionalZones?.[side] || null;
  const moduleId = damageableModuleForZone(targetEntry, zoneId);
  return applyVesselDamage(targetEntry.definition, targetEntry.instance, targetEntry.boat, {
    damage: amount,
    zoneId,
    moduleId,
    flooding: Math.max(0, Number(damageConfig.floodingPerHit) || 0),
    leak: Math.max(0, Number(config?.leakOnBoatHit) || 0),
  });
}

function damageTarget(context, target, amount, sourcePlayer, weapon, label, sourcePoint, config) {
  const world = context.world;
  if (!target) return false;
  if (target.kind === "player") {
    return applyCombatDamage(world, target.playerIndex, amount, sourcePlayer, {
      weapon,
      heavy: false,
      eventType: "vessel-mounted-player-hit",
      sourcePoint,
    }, {});
  }
  if (target.kind === "boat") {
    const targetEntry = (context.nativeVessels || []).find(entry => entry?.boat === target.point || entry?.boat?.id === target.boatId);
    if (targetEntry?.definition?.capabilities?.zonalDamage === true && targetEntry.definition?.damage?.mode === "zonal") {
      return zonalBoatDamage(context, targetEntry, amount, sourcePoint, config).hullDamage > 0;
    }
    return applyBoatDamage(target.point, amount, {
      armorShare: 0.72,
      leakShare: Math.max(0.01, Number(config?.leakOnBoatHit) || 0.045),
    }).damage > 0;
  }
  if (target.kind === "gunner") return damageHostileGunner(world, target.gunnerId, amount, sourcePlayer);
  if (["hostileActor", "elite"].includes(target.kind)) return damageHostileActor(world, target.actorId, amount, sourcePlayer, {weapon});
  if (target.kind === "escort") return damageEscort(world, target.pursuerId, amount, sourcePlayer, MOUNTED_ENEMY_BOAT_HELPERS, {weapon});
  if (target.kind === "enemyBoat") return damageEnemyBoat(world, target.enemyBoatId, amount, sourcePlayer, MOUNTED_ENEMY_BOAT_HELPERS, {weapon});
  if (["heavyHull", "heavyTurret", "heavyEngine"].includes(target.kind)) {
    return damageHeavyPursuer(world, target.component || "hull", amount, sourcePlayer, MOUNTED_ENEMY_BOAT_HELPERS, {weapon});
  }
  if (["eliteArmor", "eliteHull", "eliteTurret", "eliteBombBay"].includes(target.kind)) {
    return damageEliteBoatBoss(world, target.component || "hull", amount, sourcePlayer, {weapon, turretId: target.turretId});
  }
  if (target.kind === "marauder") {
    target.point.hull = Math.max(0, (Number(target.point.hull) || 0) - amount);
    if (target.point.hull <= 0) destroyMarauder(world, target, sourcePlayer, weapon, label);
    return true;
  }
  return false;
}

function updateMountedWeapons(context) {
  const world = context?.world;
  const dt = clamp(context?.dt, 0, 0.1);
  if (!world) return;

  for (const entry of context.nativeVessels || []) {
    const boat = entry?.boat;
    if (!boat) continue;
    for (const mounted of mountedWeapons(entry)) {
      mounted.state.cooldown = Math.max(0, (Number(mounted.state.cooldown) || 0) - dt);
      const operator = weaponOperator(entry, mounted);
      const playerIndex = operator?.playerIndex;
      const player = Number.isInteger(playerIndex) ? world.players?.[playerIndex] : null;
      if (!player || player.mode !== "boat" || player.activeBoat !== boat.id) continue;
      if (!operatorInput(entry, world, playerIndex).attack) continue;
      if (player.combat?.alive === false || boat.sunk || boat.reserved) continue;
      if (mounted.state.enabled === false || (Number(mounted.state.health) || 0) <= 0) continue;

      const config = mounted.definition.config || {};
      const label = String(config.label || mounted.definition.id || "корабельная установка");
      if ((Number(mounted.state.ammo) || 0) <= 0) {
        const now = Number(world.time) || 0;
        if (now - (Number(mounted.state.lastDeniedAt) || -999) >= 1.2) {
          mounted.state.lastDeniedAt = now;
          emit(world, "action-denied", String(config.emptyText || `В установке «${label}» закончились патроны.`), [playerIndex], {
            sourcePlayer: playerIndex,
            boatId: boat.id,
            moduleId: mounted.definition.id,
          });
        }
        continue;
      }
      if (mounted.state.cooldown > 0) continue;

      const range = Math.max(10, Number(config.range) || 620);
      const damage = Math.max(0.1, Number(config.damage) || 10);
      const interval = Math.max(0.04, Number(config.interval) || 0.18);
      const weapon = String(config.weaponId || mounted.definition.id);
      const sourcePoint = weaponSourcePoint(entry, mounted);
      const target = selectTarget(world, playerIndex, boat, range);
      const heading = target ? targetBearing(sourcePoint, target.point) : Number(boat.heading) || 0;
      const fallbackImpact = emptyImpact(sourcePoint, heading, range);
      const impactX = Number.isFinite(Number(target?.point?.x)) ? Number(target.point.x) : fallbackImpact.x;
      const impactY = Number.isFinite(Number(target?.point?.y)) ? Number(target.point.y) : fallbackImpact.y;
      const applied = target ? Boolean(damageTarget(context, target, damage, playerIndex, weapon, label, sourcePoint, config)) : false;

      mounted.state.ammo = Math.max(0, Math.floor(Number(mounted.state.ammo) || 0) - 1);
      mounted.state.cooldown = interval;
      emit(world, "vessel-mounted-shot", "", [0, 1], {
        sourcePlayer: playerIndex,
        boatId: boat.id,
        boatType: boat.boatType,
        audioProfile: boat.audioProfile,
        moduleId: mounted.definition.id,
        stationId: operator.station.object.id,
        weapon,
        weaponLabel: label,
        ammo: mounted.state.ammo,
        damage,
        instant: true,
        hit: Boolean(target),
        applied,
        targetId: target?.id ?? null,
        targetKind: target?.kind ?? null,
        heading,
        x: sourcePoint.x,
        y: sourcePoint.y,
        impactX,
        impactY,
      });
    }
  }
}

export const VESSEL_MOUNTED_WEAPON_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-station-hitscan-weapons-v2",
    phase: "before-step",
    order: 11,
    run: updateMountedWeapons,
  }),
]);
