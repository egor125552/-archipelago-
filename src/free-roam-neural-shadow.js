"use strict";

import model from "./generated/free-roam-tactical-policy-v1.js";
import {createTacticalPolicyRuntime, verifyTacticalPolicyGolden} from "./free-roam-neural-policy.js";

const WORLD_WIDTH = 420;
const WORLD_HEIGHT = 320;
const SAMPLE_SECONDS = Math.max(0.1, Number(model.sampleSeconds) || 0.2);
const SHADOW_INTERVAL_MS = Math.max(100, Math.round(SAMPLE_SECONDS * 1000));
const HEAVY_TURRET_FIRE_THRESHOLD = 0.22;
const HEAVY_TURRET_FIRE_LATCH_STEPS = Math.max(8, Math.ceil(2.4 / SAMPLE_SECONDS));
const HEAVY_TURRET_EXPLORATION_WAIT_STEPS = Math.max(12, Math.ceil(3 / SAMPLE_SECONDS));
const DEFAULT_FIRE_LATCH_STEPS = 2;
const runtime = createTacticalPolicyRuntime(model);
const golden = verifyTacticalPolicyGolden(model);
if (!golden.ok) throw new Error(`Neural tactical policy failed golden verification: ${golden.maximumError}`);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const distance = (left, right) => Math.hypot((Number(left?.x) || 0) - (Number(right?.x) || 0), (Number(left?.y) || 0) - (Number(right?.y) || 0));

function alivePlayers(world) {
  return (world?.players || [])
    .map((player, index) => ({player, index}))
    .filter(({player, index}) => Boolean(world?.freeActivities?.presence?.[index]) && player?.combat?.alive !== false && player?.mode !== "dead");
}

export function neuralPlayerPoint(world, player) {
  if (["boat", "roof"].includes(player?.mode)) return world?.boats?.[player.activeBoat] || player;
  return player;
}

export function neuralTargetForActor(world, actor) {
  const players = alivePlayers(world);
  if (!players.length) return null;
  const requested = Number(actor?.entity?.targetPlayer);
  const assigned = world?.freeThreatDirector?.assignments?.[actor.id];
  const explicit = Number.isInteger(requested) ? requested : Number.isInteger(assigned) ? assigned : -1;
  const direct = players.find(item => item.index === explicit);
  if (direct) return direct;
  return players.sort((left, right) => distance(actor.entity, neuralPlayerPoint(world, left.player)) - distance(actor.entity, neuralPlayerPoint(world, right.player)))[0];
}

function activeEntity(entity) {
  if (!entity || entity.active === false || entity.destroyed || entity.sunk) return false;
  const health = Number(entity.hull ?? entity.health);
  return !Number.isFinite(health) || health > 0;
}

function actorId(prefix, entity, index = 0) {
  return String(entity?.id || `${prefix}-${index}`);
}

export function collectNeuralActors(world) {
  const result = [];
  const pushBoat = (prefix, entity, role, index = 0, controls = {}) => {
    if (!activeEntity(entity)) return;
    result.push({
      id: actorId(prefix, entity, index),
      entity,
      kind: "boat",
      role,
      controlsMovement: controls.movement !== false,
      controlsFire: controls.fire !== false,
    });
  };
  const pushFoot = (prefix, entity, index = 0) => {
    if (!activeEntity(entity)) return;
    result.push({
      id: actorId(prefix, entity, index),
      entity,
      kind: "foot",
      role: entity?.role || "actor",
      controlsMovement: true,
      controlsFire: true,
    });
  };

  pushBoat("marauder", world?.freeActivities?.marauder, "marauder");
  (world?.freePursuerSquad?.escorts || []).forEach((entity, index) => pushBoat("escort", entity, entity?.role || "escort", index));
  (world?.freeEnemyBoats?.boats || []).forEach((entity, index) => pushBoat("threat-boat", entity, entity?.role || "boat", index));

  const heavy = world?.freeHeavyPursuer?.boat;
  pushBoat("heavy", heavy, "heavy", 0, {fire: false});
  if (activeEntity(heavy) && !heavy.turretDisabled && Number(heavy.turretHealth) > 0) {
    result.push({
      id: `${actorId("heavy", heavy)}:turret`,
      entity: heavy,
      kind: "turret",
      role: "heavy_turret",
      controlsMovement: false,
      controlsFire: true,
    });
  }

  (world?.freeHostileGunners?.gunners || []).forEach((entity, index) => pushFoot("gunner", entity, index));
  (world?.freeHostileActors?.actors || []).forEach((entity, index) => pushFoot("actor", entity, index));
  return result;
}

function weaponCode(actor) {
  const raw = String(actor?.entity?.weapon || "").toLowerCase();
  if (raw.includes("automatic") || raw.includes("rifle") || actor.role === "heavy" || actor.role === "heavy_turret" || actor.role === "gunboat") return "automatic";
  if (raw.includes("pistol") || raw.includes("gun")) return "pistol";
  return "melee";
}

function actorHealth(actor) {
  if (actor.role === "heavy_turret") {
    const maximum = Number(actor?.entity?.maxTurretHealth) || 240;
    return clamp((Number(actor?.entity?.turretHealth) || 0) / Math.max(1, maximum), 0, 1);
  }
  const maximum = Number(actor?.entity?.hullMax ?? actor?.entity?.maxHull ?? actor?.entity?.healthMax ?? actor?.entity?.maxHealth);
  const current = Number(actor?.entity?.hull ?? actor?.entity?.health ?? 100);
  if (Number.isFinite(maximum) && maximum > 0) return clamp(current / maximum, 0, 1);
  if (actor.kind === "boat") return clamp(current / Math.max(100, current), 0, 1);
  return clamp(current / 100, 0, 1);
}

function targetHealth(player) {
  return clamp((Number(player?.combat?.health) || 0) / 100, 0, 1);
}

function targetMode(player) {
  if (["boat", "roof"].includes(player?.mode)) return "boat";
  if (["foot", "swim"].includes(player?.mode)) return "foot";
  return "other";
}

export function neuralFeatureVector(world, actor, state = null) {
  const entity = actor.entity;
  const targetEntry = neuralTargetForActor(world, actor);
  const target = targetEntry?.player || null;
  const targetPoint = target ? neuralPlayerPoint(world, target) : null;
  const x = Number(entity?.x) || 0;
  const y = Number(entity?.y) || 0;
  const heading = Number(entity?.heading) || 0;
  const radians = heading * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = targetPoint ? (Number(targetPoint.x) || 0) - x : 0;
  const dy = targetPoint ? (Number(targetPoint.y) || 0) - y : 0;
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const targetDistance = Math.hypot(dx, dy);
  const bearing = Math.atan2(localX, -localY);
  const players = alivePlayers(world);
  const nearPlayers = players.filter(item => distance(entity, neuralPlayerPoint(world, item.player)) <= 40).length;
  const heavy = world?.freeHeavyPursuer?.boat;
  const heavyActive = activeEntity(heavy);
  const weapon = weaponCode(actor);
  const modeBoat = actor.kind === "boat";
  const modeFoot = actor.kind === "foot";
  const modeSwim = actor.kind === "swim";
  const targetKind = targetMode(target);
  const ammoRaw = Number(entity?.ammo ?? entity?.rounds ?? entity?.magazine);
  const ammo = Number.isFinite(ammoRaw) ? clamp(ammoRaw / 240, 0, 1) : 0.5;
  const hull = actor.kind === "boat" ? actorHealth(actor) : 1;
  const water = actor.kind === "boat" ? clamp((Number(entity?.water) || 0) / 100, 0, 1) : 0;
  const leak = actor.kind === "boat" ? clamp((Number(entity?.leak) || 0) / 8, 0, 1) : 0;
  const fuel = actor.kind === "boat" ? clamp((Number(entity?.fuel) || 100) / 100, 0, 1) : 0;
  const values = [
    1, actorHealth(actor), Number(modeBoat), Number(modeFoot), Number(modeSwim), Number(!modeBoat && !modeFoot && !modeSwim),
    x / WORLD_WIDTH, y / WORLD_HEIGHT, Math.sin(radians), Math.cos(radians), clamp((Number(entity?.speed) || 0) / 22, -1, 1),
    x / WORLD_WIDTH, (WORLD_WIDTH - x) / WORLD_WIDTH, y / WORLD_HEIGHT, (WORLD_HEIGHT - y) / WORLD_HEIGHT,
    hull, water, leak, fuel,
    Number(weapon === "melee"), Number(weapon === "pistol"), Number(weapon === "automatic"), ammo,
    clamp(localX / 160, -1.5, 1.5), clamp(localY / 160, -1.5, 1.5), clamp(targetDistance / 160, 0, 2),
    Math.sin(bearing), Math.cos(bearing), targetHealth(target) * 0.3333333333,
    Number(targetKind === "boat"), Number(targetKind === "foot"), Number(targetKind === "other" && Boolean(target)),
    clamp(players.length / 16, 0, 1), clamp(nearPlayers / 8, 0, 1), Number(heavyActive), clamp((Number(heavy?.hull ?? heavy?.health) || 0) / 600, 0, 2),
    clamp((Number(world?.freeThreatDirector?.level) || 0) / 5, 0, 1), clamp((Number(world?.time) || 0) / 360, 0, 1), Number(Boolean(state?.fire)), (Number(state?.movementIndex) || 0) / 4,
  ];
  if (values.length !== model.inputSize) throw new RangeError(`Neural shadow feature count ${values.length} does not match ${model.inputSize}`);
  return values;
}

function ensureShadowRuntime(serverRoom) {
  if (!serverRoom.neuralShadowRuntime) {
    Object.defineProperty(serverRoom, "neuralShadowRuntime", {
      value: {nextAt: 0, lastAt: 0, actors: new Map(), summary: null, controlEnabled: false, testControl: false},
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const state = serverRoom.neuralShadowRuntime;
  if (!(state.actors instanceof Map)) state.actors = new Map();
  if (typeof state.controlEnabled !== "boolean") state.controlEnabled = false;
  if (typeof state.testControl !== "boolean") state.testControl = false;
  return state;
}

function fireDecision(actor, result, previous) {
  const threshold = actor.role === "heavy_turret" ? HEAVY_TURRET_FIRE_THRESHOLD : 0.5;
  const rawFire = result.fireProbability >= threshold;
  const waitSteps = rawFire ? 0 : (Number(previous?.fireWaitSteps) || 0) + 1;
  const forcedExploration = actor.role === "heavy_turret"
    && !rawFire
    && waitSteps >= HEAVY_TURRET_EXPLORATION_WAIT_STEPS;
  const permissionStarted = rawFire || forcedExploration;
  const latchSteps = actor.role === "heavy_turret" ? HEAVY_TURRET_FIRE_LATCH_STEPS : DEFAULT_FIRE_LATCH_STEPS;
  const fireLatch = permissionStarted ? latchSteps : Math.max(0, (Number(previous?.fireLatch) || 0) - 1);
  return {
    rawFire,
    fire: permissionStarted || fireLatch > 0,
    fireLatch,
    fireWaitSteps: permissionStarted ? 0 : waitSteps,
    forcedExploration,
    threshold,
  };
}

export function updateServerNeuralShadow(serverRoom, now = Date.now()) {
  if (!serverRoom?.world) return null;
  const shadow = ensureShadowRuntime(serverRoom);
  if (now < shadow.nextAt) return neuralShadowStatus(serverRoom);
  shadow.nextAt = now + SHADOW_INTERVAL_MS;
  shadow.lastAt = now;

  const actors = collectNeuralActors(serverRoom.world);
  const seen = new Set();
  const movementCounts = Object.fromEntries(model.movementClasses.map(name => [name, 0]));
  const actorKinds = {};
  let confidenceTotal = 0;
  let fireTotal = 0;
  let fireAllowedCount = 0;
  let forcedExplorationCount = 0;
  let lowConfidenceCount = 0;
  let heavyTurretTracked = false;
  let heavyTurretFire = false;
  let heavyTurretFireProbability = 0;
  let heavyTurretForcedExploration = false;

  for (const actor of actors) {
    seen.add(actor.id);
    const previous = shadow.actors.get(actor.id) || {hidden: null, movementIndex: 0, fire: false, fireLatch: 0, fireWaitSteps: 0};
    const result = runtime.step(neuralFeatureVector(serverRoom.world, actor, previous), previous.hidden);
    const fire = fireDecision(actor, result, previous);
    const next = {
      hidden: result.hidden,
      movementIndex: result.movementIndex,
      movement: result.movement,
      confidence: result.movementConfidence,
      fire: fire.fire,
      rawFire: fire.rawFire,
      fireLatch: fire.fireLatch,
      fireWaitSteps: fire.fireWaitSteps,
      forcedExploration: fire.forcedExploration,
      fireThreshold: fire.threshold,
      fireProbability: result.fireProbability,
      targetPlayer: Number.isInteger(actor.entity?.targetPlayer) ? actor.entity.targetPlayer : null,
      kind: actor.kind,
      role: actor.role,
      controlsMovement: actor.controlsMovement !== false,
      controlsFire: actor.controlsFire !== false,
      lastSeenAt: now,
    };
    shadow.actors.set(actor.id, next);
    movementCounts[next.movement] = (movementCounts[next.movement] || 0) + 1;
    actorKinds[actor.kind] = (actorKinds[actor.kind] || 0) + 1;
    confidenceTotal += next.confidence;
    fireTotal += next.fireProbability;
    if (next.fire && next.controlsFire) fireAllowedCount += 1;
    if (next.forcedExploration) forcedExplorationCount += 1;
    if (next.confidence < 0.25) lowConfidenceCount += 1;
    if (actor.role === "heavy_turret") {
      heavyTurretTracked = true;
      heavyTurretFire = next.fire;
      heavyTurretFireProbability = next.fireProbability;
      heavyTurretForcedExploration = next.forcedExploration;
    }
  }
  for (const id of shadow.actors.keys()) if (!seen.has(id)) shadow.actors.delete(id);
  const controlEnabled = Boolean(shadow.controlEnabled && (model.controlApproved === true || shadow.testControl));
  shadow.summary = {
    enabled: true,
    controlEnabled,
    modelFormat: model.format,
    modelVersion: model.version,
    actorCount: actors.length,
    actorKinds,
    meanMovementConfidence: actors.length ? confidenceTotal / actors.length : 0,
    meanFireProbability: actors.length ? fireTotal / actors.length : 0,
    fireAllowedCount,
    forcedExplorationCount,
    lowConfidenceCount,
    heavyTurretTracked,
    heavyTurretFire,
    heavyTurretFireProbability,
    heavyTurretForcedExploration,
    movementCounts,
    updatedAt: now,
  };
  return neuralShadowStatus(serverRoom);
}

export function neuralDecision(serverRoom, actorId) {
  return serverRoom?.neuralShadowRuntime?.actors?.get(String(actorId || "")) || null;
}

export function neuralDecisionSnapshot(serverRoom) {
  const actors = serverRoom?.neuralShadowRuntime?.actors;
  if (!(actors instanceof Map)) return [];
  return [...actors.entries()].map(([id, decision]) => ({
    id,
    movement: decision.movement,
    movementIndex: decision.movementIndex,
    confidence: decision.confidence,
    fire: decision.fire,
    rawFire: decision.rawFire,
    fireProbability: decision.fireProbability,
    fireThreshold: decision.fireThreshold,
    fireLatch: decision.fireLatch,
    fireWaitSteps: decision.fireWaitSteps,
    forcedExploration: decision.forcedExploration,
    targetPlayer: decision.targetPlayer,
    kind: decision.kind,
    role: decision.role,
    controlsMovement: decision.controlsMovement,
    controlsFire: decision.controlsFire,
    lastSeenAt: decision.lastSeenAt,
  }));
}

export function neuralControlEnabled(serverRoom) {
  const shadow = serverRoom?.neuralShadowRuntime;
  return Boolean(shadow?.controlEnabled && (model.controlApproved === true || shadow.testControl));
}

export function setServerNeuralControlForTest(serverRoom, enabled) {
  const shadow = ensureShadowRuntime(serverRoom);
  shadow.controlEnabled = Boolean(enabled);
  shadow.testControl = Boolean(enabled);
  shadow.nextAt = 0;
  return neuralControlEnabled(serverRoom);
}

export function neuralShadowStatus(serverRoom) {
  const shadow = serverRoom?.neuralShadowRuntime;
  return shadow?.summary ? structuredClone(shadow.summary) : {
    enabled: true,
    controlEnabled: neuralControlEnabled(serverRoom),
    modelFormat: model.format,
    modelVersion: model.version,
    actorCount: 0,
    actorKinds: {},
    meanMovementConfidence: 0,
    meanFireProbability: 0,
    fireAllowedCount: 0,
    forcedExplorationCount: 0,
    lowConfidenceCount: 0,
    heavyTurretTracked: false,
    heavyTurretFire: false,
    heavyTurretFireProbability: 0,
    heavyTurretForcedExploration: false,
    movementCounts: Object.fromEntries(model.movementClasses.map(name => [name, 0])),
    updatedAt: 0,
  };
}

export function clearServerNeuralShadow(serverRoom) {
  if (serverRoom) delete serverRoom.neuralShadowRuntime;
}
