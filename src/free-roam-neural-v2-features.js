"use strict";

import {
  collectNeuralActors,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "./free-roam-neural-shadow.js";
import {
  neuralV2ActionFeatureState,
  validateNeuralV2FeatureVector,
} from "./free-roam-neural-v2-schema.js";

const WORLD_WIDTH = 420;
const WORLD_HEIGHT = 320;
const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;
const SHORE_GATE_MIN_X = 118;
const SHORE_GATE_MAX_X = 302;
const SHORE_GATE_Y = 88;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (left, right) => Math.hypot((Number(left?.x) || 0) - (Number(right?.x) || 0), (Number(left?.y) || 0) - (Number(right?.y) || 0));

function healthRatio(current, maximum, fallbackMaximum = 100) {
  const max = Number(maximum) > 0 ? Number(maximum) : Math.max(fallbackMaximum, Number(current) || 0);
  return clamp((Number(current) || 0) / Math.max(1, max), 0, 1);
}

function actorHealth(actor) {
  const entity = actor?.entity || {};
  if (actor?.role === "heavy_turret") return healthRatio(entity.turretHealth, entity.maxTurretHealth, 240);
  return healthRatio(entity.hull ?? entity.health, entity.maxHull ?? entity.hullMax ?? entity.maxHealth ?? entity.healthMax, actor?.kind === "boat" ? 100 : 100);
}

function targetMode(player) {
  if (["boat", "roof"].includes(player?.mode)) return "boat";
  if (player?.mode === "swim") return "swim";
  if (player?.mode === "foot") return "foot";
  return "other";
}

function localVector(origin, heading, point) {
  const radians = (Number(heading) || 0) * Math.PI / 180;
  const dx = (Number(point?.x) || 0) - (Number(origin?.x) || 0);
  const dy = (Number(point?.y) || 0) - (Number(origin?.y) || 0);
  return {
    x: dx * Math.cos(radians) + dy * Math.sin(radians),
    y: -dx * Math.sin(radians) + dy * Math.cos(radians),
    distance: Math.hypot(dx, dy),
  };
}

function activeBoatEntities(world) {
  return [
    ...(world?.boats || []),
    world?.freeActivities?.marauder,
    ...(world?.freePursuerSquad?.escorts || []),
    ...(world?.freeEnemyBoats?.boats || []),
    world?.freeHeavyPursuer?.boat,
  ].filter(entity => entity && entity.active !== false && !entity.destroyed && !entity.sunk);
}

function proximitySectors(world, actor) {
  const entity = actor?.entity || {};
  let front = Infinity;
  let left = Infinity;
  let right = Infinity;
  let collisionRisk = 0;
  const heading = Number(entity.heading) || 0;
  const speed = Math.abs(Number(entity.speed) || 0);
  for (const boat of activeBoatEntities(world)) {
    if (boat === entity || String(boat.id || "") === String(entity.id || "")) continue;
    const metres = distance(entity, boat);
    if (metres > 90 || metres < 0.001) continue;
    const bearing = Math.atan2((Number(boat.x) || 0) - (Number(entity.x) || 0), -((Number(boat.y) || 0) - (Number(entity.y) || 0))) * 180 / Math.PI;
    const relative = wrapDeg(bearing - heading);
    if (Math.abs(relative) <= 35) front = Math.min(front, metres);
    else if (relative < 0) left = Math.min(left, metres);
    else right = Math.min(right, metres);
    const closingScale = clamp((speed + Math.abs(Number(boat.speed) || 0)) / 30, 0, 1);
    const angleScale = clamp(1 - Math.abs(relative) / 90, 0, 1);
    collisionRisk = Math.max(collisionRisk, clamp((28 - metres) / 28, 0, 1) * (0.35 + 0.65 * closingScale) * angleScale);
  }
  const normalize = value => Number.isFinite(value) ? clamp(1 - value / 90, 0, 1) : 0;
  return {front: normalize(front), left: normalize(left), right: normalize(right), collisionRisk};
}

function roleFlags(role) {
  const value = String(role || "");
  return {
    heavy: Number(value === "heavy" || value === "heavy_turret"),
    rammer: Number(value === "rammer" || value === "marauder"),
    gunboat: Number(value === "gunboat" || value === "heavy_turret"),
    landing: Number(value === "landing" || value === "actor"),
    other: Number(!["heavy", "heavy_turret", "rammer", "marauder", "gunboat", "landing", "actor"].includes(value)),
  };
}

export function neuralV2FeatureVector(world, actor, state = {}) {
  const entity = actor?.entity || {};
  const targetEntry = neuralTargetForActor(world, actor);
  const target = targetEntry?.player || null;
  const targetPoint = target ? neuralPlayerPoint(world, target) : null;
  const heading = Number(entity.heading) || 0;
  const radians = heading * Math.PI / 180;
  const targetLocal = localVector(entity, heading, targetPoint || entity);
  const targetBearing = Math.atan2(targetLocal.x, -targetLocal.y);
  const gatePoint = {
    x: clamp(Number(targetPoint?.x) || 210, SHORE_GATE_MIN_X, SHORE_GATE_MAX_X),
    y: SHORE_GATE_Y,
  };
  const gateLocal = localVector(entity, heading, gatePoint);
  const targetKind = targetMode(target);
  const role = roleFlags(actor?.role);
  const proximity = proximitySectors(world, actor);
  const activeActors = collectNeuralActors(world);
  const nearActors = activeActors.filter(candidate => candidate.id !== actor?.id && distance(candidate.entity, entity) <= 45).length;
  const previous = neuralV2ActionFeatureState(state.previousAction || state.action || {});
  const isBoat = actor?.kind === "boat";
  const isFoot = actor?.kind === "foot";
  const isTurret = actor?.kind === "turret";
  const targetOnLand = Boolean(targetPoint && ((Number(targetPoint.y) || 0) < WATER_MIN_Y || ["foot", "swim"].includes(target?.mode)));
  const engineHealth = healthRatio(entity.engineHealth ?? entity.hull ?? entity.health, entity.maxEngineHealth ?? entity.maxHull ?? entity.maxHealth, 100);
  const turretHealth = healthRatio(entity.turretHealth ?? entity.hull ?? entity.health, entity.maxTurretHealth ?? entity.maxHull ?? entity.maxHealth, 100);
  const values = [
    Number(entity.active !== false && !entity.destroyed && !entity.sunk),
    actorHealth(actor),
    Number(isBoat), Number(isFoot), Number(isTurret),
    role.heavy, role.rammer, role.gunboat, role.landing, role.other,
    clamp((Number(entity.x) || 0) / WORLD_WIDTH, 0, 1),
    clamp((Number(entity.y) || 0) / WORLD_HEIGHT, 0, 1),
    Math.sin(radians), Math.cos(radians), clamp((Number(entity.speed) || 0) / 22, -1.5, 1.5),
    clamp(((Number(entity.x) || 0) - WATER_MIN_X) / (WATER_MAX_X - WATER_MIN_X), 0, 1),
    clamp((WATER_MAX_X - (Number(entity.x) || 0)) / (WATER_MAX_X - WATER_MIN_X), 0, 1),
    clamp(((Number(entity.y) || 0) - WATER_MIN_Y) / (WATER_MAX_Y - WATER_MIN_Y), 0, 1),
    clamp((WATER_MAX_Y - (Number(entity.y) || 0)) / (WATER_MAX_Y - WATER_MIN_Y), 0, 1),
    clamp(gateLocal.x / 180, -1.5, 1.5), clamp(gateLocal.y / 180, -1.5, 1.5),
    clamp(targetLocal.x / 180, -1.5, 1.5), clamp(targetLocal.y / 180, -1.5, 1.5), clamp(targetLocal.distance / 180, 0, 2.5),
    Math.sin(targetBearing), Math.cos(targetBearing),
    Number(targetKind === "boat"), Number(targetKind === "foot"), Number(targetKind === "swim"), Number(targetOnLand),
    isBoat ? actorHealth(actor) : 1,
    isBoat ? clamp((Number(entity.water) || 0) / 100, 0, 1) : 0,
    isBoat ? clamp((Number(entity.leak) || 0) / 8, 0, 1) : 0,
    isBoat ? clamp((Number(entity.fuel) || 100) / 100, 0, 1) : 0,
    engineHealth, turretHealth,
    Number(Number(entity.aimRemaining) > 0), Number(Number(entity.burstRemaining ?? entity.burstShotsRemaining) > 0),
    clamp(Number(entity.fireCooldown ?? entity.shotCooldown ?? entity.attackCooldown) / 8, 0, 1),
    proximity.front, proximity.left, proximity.right, proximity.collisionRisk,
    clamp((Number(state.stuckMs) || 0) / 5000, 0, 2),
    clamp(activeActors.length / 18, 0, 1), clamp(nearActors / 10, 0, 1),
    clamp((Number(world?.freeThreatDirector?.level) || 0) / 5, 0, 1),
    clamp((Number(world?.time) || 0) / 360, 0, 1),
    ...previous,
  ];
  return validateNeuralV2FeatureVector(values);
}
