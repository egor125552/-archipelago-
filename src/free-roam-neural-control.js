"use strict";

import {
  collectNeuralActors,
  neuralControlEnabled,
  neuralDecision,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "./free-roam-neural-shadow.js";
import {isolatedServerNeuralV2Head} from "./free-roam-neural-v2-overrides.js";

const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;
const SHORE_ACCESS_MIN_X = 118;
const SHORE_ACCESS_MAX_X = 302;
const SHORE_APPROACH_Y = 88;
const STUCK_ESCAPE_MS = 1200;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = degrees => degrees * Math.PI / 180;
const headingTo = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
const distance = (left, right) => Math.hypot((Number(left?.x) || 0) - (Number(right?.x) || 0), (Number(left?.y) || 0) - (Number(right?.y) || 0));

function roleSpeed(actor) {
  if (actor.kind === "foot") return 7.4;
  if (actor.role === "heavy") return 11.5;
  if (actor.role === "rammer") return 18.5;
  if (actor.role === "interceptor") return 17;
  if (actor.role === "gunboat") return 13.5;
  if (actor.role === "landing") return 14;
  if (actor.role === "observer") return 12;
  return 15;
}

export function neuralBoatTargetPoint(targetPoint) {
  const x = Number(targetPoint?.x) || 0;
  const y = Number(targetPoint?.y) || 0;
  if (y < WATER_MIN_Y) {
    return {
      x: clamp(x, SHORE_ACCESS_MIN_X, SHORE_ACCESS_MAX_X),
      y: SHORE_APPROACH_Y,
      redirectedFromLand: true,
    };
  }
  return {
    x: clamp(x, WATER_MIN_X + 3, WATER_MAX_X - 3),
    y: clamp(y, WATER_MIN_Y + 3, WATER_MAX_Y - 3),
    redirectedFromLand: false,
  };
}

function desiredMotion(actor, targetPoint, decision) {
  const entity = actor.entity;
  const targetHeading = headingTo(entity, targetPoint);
  const metres = distance(entity, targetPoint);
  const maximum = roleSpeed(actor);
  if (decision.movement === "hold") return {heading: Number(entity.heading) || targetHeading, speed: 0};
  if (decision.movement === "retreat") return {heading: wrapDeg(targetHeading + 180), speed: maximum * 0.92};
  if (decision.movement === "flank_left") return {heading: wrapDeg(targetHeading - 78), speed: maximum * 0.82};
  if (decision.movement === "flank_right") return {heading: wrapDeg(targetHeading + 78), speed: maximum * 0.82};
  const closeScale = metres < 14 ? 0.25 : metres < 28 ? 0.58 : 1;
  return {heading: targetHeading, speed: maximum * closeScale};
}

function heavyTurretCommitted(entity) {
  return Number(entity?.aimRemaining) > 0 || Number(entity?.burstRemaining) > 0;
}

function suppressFire(actor) {
  const entity = actor?.entity;
  if (!entity) return false;
  if (actor.role === "heavy_turret" && heavyTurretCommitted(entity)) return false;
  if (Number.isFinite(entity.fireCooldown)) entity.fireCooldown = Math.max(entity.fireCooldown, 0.28);
  if (Number.isFinite(entity.shotCooldown)) entity.shotCooldown = Math.max(entity.shotCooldown, 0.28);
  if (Number.isFinite(entity.attackCooldown)) entity.attackCooldown = Math.max(entity.attackCooldown, 0.28);
  if (Number.isFinite(entity.aimRemaining)) entity.aimRemaining = 0;
  if (Number.isFinite(entity.burstRemaining)) entity.burstRemaining = 0;
  if (Number.isFinite(entity.burstShotsRemaining)) entity.burstShotsRemaining = 0;
  return true;
}

function ensureControlRuntime(serverRoom) {
  if (!serverRoom.neuralControlRuntime) {
    Object.defineProperty(serverRoom, "neuralControlRuntime", {
      value: {
        actors: new Map(),
        totals: {
          controlled: 0,
          fallback: 0,
          fireSuppressed: 0,
          heavyTurretControlled: 0,
          waterGuardInterventions: 0,
          shorelineRedirects: 0,
          stuckEscapes: 0,
          lowConfidenceApplied: 0,
        },
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const runtime = serverRoom.neuralControlRuntime;
  if (!(runtime.actors instanceof Map)) runtime.actors = new Map();
  runtime.totals ||= {};
  return runtime;
}

function actorRuntime(serverRoom, id) {
  const runtime = ensureControlRuntime(serverRoom);
  let actor = runtime.actors.get(id);
  if (!actor) {
    actor = {stuckMs: 0, lastX: null, lastY: null, escapeSide: String(id).split("").reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 2 ? 1 : -1};
    runtime.actors.set(id, actor);
  }
  return actor;
}

function safeBoatMotion(frame, desired, state, dt) {
  let heading = desired.heading;
  let speed = desired.speed;
  let waterGuard = false;
  let stuckEscape = false;
  const horizon = 1.8;
  const projected = {
    x: frame.x + Math.sin(rad(heading)) * speed * horizon,
    y: frame.y - Math.cos(rad(heading)) * speed * horizon,
  };
  const safeProjected = {
    x: clamp(projected.x, WATER_MIN_X + 6, WATER_MAX_X - 6),
    y: clamp(projected.y, WATER_MIN_Y + 6, WATER_MAX_Y - 6),
  };
  if (Math.abs(projected.x - safeProjected.x) > 0.01 || Math.abs(projected.y - safeProjected.y) > 0.01) {
    heading = headingTo(frame, safeProjected);
    speed = Math.min(speed, roleSpeed(frame) * 0.76);
    waterGuard = true;
  }
  if (state.stuckMs >= STUCK_ESCAPE_MS && speed > 1) {
    heading = wrapDeg(heading + 92 * state.escapeSide);
    speed = Math.max(speed, roleSpeed(frame) * 0.66);
    state.escapeSide *= -1;
    state.stuckMs = 0;
    stuckEscape = true;
  }
  return {heading, speed, waterGuard, stuckEscape};
}

export function prepareServerNeuralControl(serverRoom) {
  if (!neuralControlEnabled(serverRoom) || !serverRoom?.world) return null;
  const frames = [];
  const controlRuntime = ensureControlRuntime(serverRoom);
  for (const actor of collectNeuralActors(serverRoom.world)) {
    const decision = neuralDecision(serverRoom, actor.id);
    if (!decision) continue;
    const targetEntry = neuralTargetForActor(serverRoom.world, actor);
    const rawTargetPoint = targetEntry?.player ? neuralPlayerPoint(serverRoom.world, targetEntry.player) : null;
    if (!rawTargetPoint) continue;
    const isolatedHead = isolatedServerNeuralV2Head(serverRoom, actor.id);

    if (actor.controlsFire !== false) {
      if (isolatedHead !== "fire" && !decision.fire && suppressFire(actor)) {
        controlRuntime.totals.fireSuppressed = (controlRuntime.totals.fireSuppressed || 0) + 1;
      }
      if (actor.role === "heavy_turret") controlRuntime.totals.heavyTurretControlled = (controlRuntime.totals.heavyTurretControlled || 0) + 1;
    }
    if (actor.controlsMovement === false) continue;
    if (decision.confidence < 0.25) controlRuntime.totals.lowConfidenceApplied = (controlRuntime.totals.lowConfidenceApplied || 0) + 1;

    const targetPoint = actor.kind === "boat" ? neuralBoatTargetPoint(rawTargetPoint) : {
      x: Number(rawTargetPoint.x) || 0,
      y: Number(rawTargetPoint.y) || 0,
      redirectedFromLand: false,
    };
    if (targetPoint.redirectedFromLand) controlRuntime.totals.shorelineRedirects = (controlRuntime.totals.shorelineRedirects || 0) + 1;
    frames.push({
      id: actor.id,
      entity: actor.entity,
      kind: actor.kind,
      role: actor.role,
      state: actor.entity?.state ?? null,
      x: Number(actor.entity?.x) || 0,
      y: Number(actor.entity?.y) || 0,
      heading: Number(actor.entity?.heading) || 0,
      speed: Number(actor.entity?.speed) || 0,
      targetPoint,
      decision,
    });
  }
  return frames;
}

export function finishServerNeuralControl(serverRoom, frames, dt) {
  if (!frames?.length || !neuralControlEnabled(serverRoom)) return {controlled: 0, fallback: 0};
  const controlRuntime = ensureControlRuntime(serverRoom);
  let controlled = 0;
  let fallback = 0;
  for (const frame of frames) {
    const entity = frame.entity;
    if (!entity || entity.active === false || entity.destroyed || entity.sunk) continue;
    if (frame.kind === "foot" && frame.state != null && entity.state !== frame.state) {
      fallback += 1;
      continue;
    }

    const state = actorRuntime(serverRoom, frame.id);
    const productionMovement = Math.hypot((Number(entity.x) || 0) - frame.x, (Number(entity.y) || 0) - frame.y);
    if (frame.decision.movement !== "hold" && productionMovement < 0.018) state.stuckMs += Math.max(0, Number(dt) || 0) * 1000;
    else state.stuckMs = Math.max(0, state.stuckMs - Math.max(0, Number(dt) || 0) * 450);

    let desired = desiredMotion(frame, frame.targetPoint, frame.decision);
    let waterGuard = false;
    let stuckEscape = false;
    if (frame.kind === "boat") {
      const safe = safeBoatMotion(frame, desired, state, dt);
      desired = safe;
      waterGuard = safe.waterGuard;
      stuckEscape = safe.stuckEscape;
    }

    const turnRate = frame.kind === "foot" ? 260 : 115;
    const acceleration = frame.kind === "foot" ? 28 : 15;
    const nextHeading = wrapDeg(frame.heading + clamp(wrapDeg(desired.heading - frame.heading), -turnRate * dt, turnRate * dt));
    const nextSpeed = frame.speed + clamp(desired.speed - frame.speed, -acceleration * dt, acceleration * dt);
    const radians = rad(nextHeading);
    let nextX = frame.x + Math.sin(radians) * nextSpeed * dt;
    let nextY = frame.y - Math.cos(radians) * nextSpeed * dt;
    if (frame.kind === "boat") {
      const clampedX = clamp(nextX, WATER_MIN_X, WATER_MAX_X);
      const clampedY = clamp(nextY, WATER_MIN_Y, WATER_MAX_Y);
      if (clampedX !== nextX || clampedY !== nextY) waterGuard = true;
      nextX = clampedX;
      nextY = clampedY;
    } else {
      nextX = clamp(nextX, 5, 415);
      nextY = clamp(nextY, 5, 315);
    }
    entity.heading = nextHeading;
    entity.speed = nextSpeed;
    entity.x = nextX;
    entity.y = nextY;
    state.lastX = nextX;
    state.lastY = nextY;
    if (waterGuard) controlRuntime.totals.waterGuardInterventions = (controlRuntime.totals.waterGuardInterventions || 0) + 1;
    if (stuckEscape) controlRuntime.totals.stuckEscapes = (controlRuntime.totals.stuckEscapes || 0) + 1;
    controlled += 1;
  }
  controlRuntime.totals.controlled = (controlRuntime.totals.controlled || 0) + controlled;
  controlRuntime.totals.fallback = (controlRuntime.totals.fallback || 0) + fallback;
  return {controlled, fallback};
}

export function neuralControlDiagnostics(serverRoom) {
  const runtime = serverRoom?.neuralControlRuntime;
  return runtime ? structuredClone(runtime.totals || {}) : {
    controlled: 0,
    fallback: 0,
    fireSuppressed: 0,
    heavyTurretControlled: 0,
    waterGuardInterventions: 0,
    shorelineRedirects: 0,
    stuckEscapes: 0,
    lowConfidenceApplied: 0,
  };
}
