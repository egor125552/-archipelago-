"use strict";

import {
  collectNeuralActors,
  neuralDecision,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "./free-roam-neural-shadow.js";
import {
  neuralV2DesiredMotion,
  neuralV2RoleSpeed,
  neuralV2RoutePoint,
} from "./free-roam-neural-v2-control.js";
import {
  neuralV2PreferredRange,
  neuralV2SteeringOffset,
  neuralV2ThrottleScale,
  normalizeNeuralV2Action,
} from "./free-roam-neural-v2-schema.js";

const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;
const ISOLATED_HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = degrees => Number(degrees) * Math.PI / 180;
const distance = (left, right) => Math.hypot(
  (Number(left?.x) || 0) - (Number(right?.x) || 0),
  (Number(left?.y) || 0) - (Number(right?.y) || 0),
);
const headingTo = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

function v1RoleSpeed(actor) {
  if (actor?.kind === "foot") return 7.4;
  if (actor?.role === "heavy") return 11.5;
  if (actor?.role === "rammer") return 18.5;
  if (actor?.role === "interceptor") return 17;
  if (actor?.role === "gunboat") return 13.5;
  if (actor?.role === "landing") return 14;
  if (actor?.role === "observer") return 12;
  return 15;
}

function v1DesiredMotion(actor, targetPoint, decision) {
  const entity = actor?.entity || actor || {};
  const targetHeading = headingTo(entity, targetPoint);
  const metres = distance(entity, targetPoint);
  const maximum = v1RoleSpeed(actor);
  const movement = String(decision?.movement || "hold");
  if (movement === "hold") return {heading: Number(entity.heading) || targetHeading, speed: 0};
  if (movement === "retreat") return {heading: wrapDeg(targetHeading + 180), speed: maximum * 0.92};
  if (movement === "flank_left") return {heading: wrapDeg(targetHeading - 78), speed: maximum * 0.82};
  if (movement === "flank_right") return {heading: wrapDeg(targetHeading + 78), speed: maximum * 0.82};
  const closeScale = metres < 14 ? 0.25 : metres < 28 ? 0.58 : 1;
  return {heading: targetHeading, speed: maximum * closeScale};
}

function blankHeadEffect() {
  return {
    frames: 0,
    changedFrames: 0,
    headingDeltaTotal: 0,
    speedDeltaTotal: 0,
    positionDeltaTotal: 0,
    fireAllowedFrames: 0,
    fireSuppressedFrames: 0,
  };
}

function blankDiagnostics() {
  return {
    preparedFrames: 0,
    controlledFrames: 0,
    movementFrames: 0,
    fireAllowedFrames: 0,
    fireSuppressedFrames: 0,
    waterClampFrames: 0,
    waterGuardInterventions: 0,
    missingActorFrames: 0,
    missingTargetFrames: 0,
    isolatedHeadFrames: Object.fromEntries(ISOLATED_HEADS.map(head => [head, 0])),
    isolatedHeadEffects: Object.fromEntries(ISOLATED_HEADS.map(head => [head, blankHeadEffect()])),
  };
}

function ensureRuntime(serverRoom) {
  if (!serverRoom.neuralV2OverrideRuntime) {
    Object.defineProperty(serverRoom, "neuralV2OverrideRuntime", {
      value: {actions: new Map(), diagnostics: blankDiagnostics()},
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const runtime = serverRoom.neuralV2OverrideRuntime;
  if (!(runtime.actions instanceof Map)) runtime.actions = new Map();
  runtime.diagnostics ||= blankDiagnostics();
  for (const key of [
    "preparedFrames",
    "controlledFrames",
    "movementFrames",
    "fireAllowedFrames",
    "fireSuppressedFrames",
    "waterClampFrames",
    "waterGuardInterventions",
    "missingActorFrames",
    "missingTargetFrames",
  ]) {
    if (!Number.isFinite(Number(runtime.diagnostics[key]))) runtime.diagnostics[key] = 0;
  }
  runtime.diagnostics.isolatedHeadFrames ||= {};
  runtime.diagnostics.isolatedHeadEffects ||= {};
  for (const head of ISOLATED_HEADS) {
    if (!Number.isFinite(Number(runtime.diagnostics.isolatedHeadFrames[head]))) {
      runtime.diagnostics.isolatedHeadFrames[head] = 0;
    }
    runtime.diagnostics.isolatedHeadEffects[head] ||= blankHeadEffect();
    for (const key of Object.keys(blankHeadEffect())) {
      if (!Number.isFinite(Number(runtime.diagnostics.isolatedHeadEffects[head][key]))) {
        runtime.diagnostics.isolatedHeadEffects[head][key] = 0;
      }
    }
  }
  return runtime;
}

function normalizeOverride(rawAction = {}) {
  const action = normalizeNeuralV2Action({...rawAction, source: rawAction.source || "server-test"});
  const head = ISOLATED_HEADS.includes(rawAction.head) ? rawAction.head : null;
  return Object.freeze({...action, head, isolated: Boolean(head)});
}

export function setServerNeuralV2Override(serverRoom, actorId, rawAction) {
  if (!serverRoom || !actorId) return false;
  const runtime = ensureRuntime(serverRoom);
  if (rawAction == null) {
    runtime.actions.delete(String(actorId));
    return true;
  }
  runtime.actions.set(String(actorId), normalizeOverride(rawAction));
  return true;
}

export function isolatedServerNeuralV2Head(serverRoom, actorId) {
  const action = serverRoom?.neuralV2OverrideRuntime?.actions?.get(String(actorId || ""));
  return action?.isolated ? action.head : null;
}

export function clearServerNeuralV2Overrides(serverRoom) {
  if (serverRoom) delete serverRoom.neuralV2OverrideRuntime;
}

export function neuralV2OverrideSnapshot(serverRoom) {
  const runtime = serverRoom?.neuralV2OverrideRuntime;
  if (!(runtime?.actions instanceof Map)) return [];
  return [...runtime.actions.entries()].map(([id, action]) => ({id, ...action}));
}

function suppressFire(entity) {
  if (!entity) return false;
  if (Number(entity.aimRemaining) > 0 || Number(entity.burstRemaining ?? entity.burstShotsRemaining) > 0) return false;
  if (Number.isFinite(entity.fireCooldown)) entity.fireCooldown = Math.max(entity.fireCooldown, 0.3);
  if (Number.isFinite(entity.shotCooldown)) entity.shotCooldown = Math.max(entity.shotCooldown, 0.3);
  if (Number.isFinite(entity.attackCooldown)) entity.attackCooldown = Math.max(entity.attackCooldown, 0.3);
  if (Number.isFinite(entity.aimRemaining)) entity.aimRemaining = 0;
  if (Number.isFinite(entity.burstRemaining)) entity.burstRemaining = 0;
  if (Number.isFinite(entity.burstShotsRemaining)) entity.burstShotsRemaining = 0;
  return true;
}

export function prepareServerNeuralV2Overrides(serverRoom) {
  const runtime = serverRoom?.neuralV2OverrideRuntime;
  if (!serverRoom?.world || !(runtime?.actions instanceof Map) || runtime.actions.size === 0) return null;
  const actors = new Map(collectNeuralActors(serverRoom.world).map(actor => [actor.id, actor]));
  const frames = [];
  for (const [id, action] of runtime.actions) {
    const actor = actors.get(id);
    if (!actor) {
      runtime.diagnostics.missingActorFrames += 1;
      continue;
    }
    const targetEntry = neuralTargetForActor(serverRoom.world, actor);
    const targetPoint = targetEntry?.player ? neuralPlayerPoint(serverRoom.world, targetEntry.player) : null;
    if (!targetPoint) {
      runtime.diagnostics.missingTargetFrames += 1;
      continue;
    }
    const baseDecision = neuralDecision(serverRoom, id);
    if (action.isolated && action.head === "fire" && actor.controlsFire !== false) {
      const effect = runtime.diagnostics.isolatedHeadEffects.fire;
      const baseFire = Boolean(baseDecision?.fire);
      runtime.diagnostics.isolatedHeadFrames.fire += 1;
      effect.frames += 1;
      if (baseFire !== action.fire) effect.changedFrames += 1;
      if (action.fire) {
        runtime.diagnostics.fireAllowedFrames += 1;
        effect.fireAllowedFrames += 1;
      } else if (suppressFire(actor.entity)) {
        runtime.diagnostics.fireSuppressedFrames += 1;
        effect.fireSuppressedFrames += 1;
      }
    }
    frames.push({
      id,
      actor,
      entity: actor.entity,
      action,
      baseDecision,
      x: Number(actor.entity?.x) || 0,
      y: Number(actor.entity?.y) || 0,
      heading: Number(actor.entity?.heading) || 0,
      speed: Number(actor.entity?.speed) || 0,
      state: actor.entity?.state ?? null,
      targetPoint: {x: Number(targetPoint.x) || 0, y: Number(targetPoint.y) || 0},
    });
  }
  runtime.diagnostics.preparedFrames += frames.length;
  return frames;
}

function isolatedMotion(frame, seconds) {
  const action = frame.action;
  const head = action.head;
  const v1Intent = v1DesiredMotion(frame.actor, frame.targetPoint, frame.baseDecision);
  const turnRate = frame.actor.kind === "foot" ? 280 : frame.actor.role === "heavy" ? 75 : 125;
  const acceleration = frame.actor.kind === "foot" ? 30 : frame.actor.role === "heavy" ? 8 : 16;
  let desiredHeading = v1Intent.heading;
  let desiredSpeed = v1Intent.speed;

  if (head === "throttle") {
    desiredSpeed = neuralV2RoleSpeed(frame.actor) * neuralV2ThrottleScale(action);
  } else if (head === "steering") {
    desiredHeading = wrapDeg(v1Intent.heading + neuralV2SteeringOffset(action));
  } else if (head === "range") {
    const metres = distance(frame, frame.targetPoint);
    const preferred = neuralV2PreferredRange(action);
    const tolerance = Math.max(5, preferred * 0.16);
    if (action.range === "disengage" || metres < preferred - tolerance) {
      desiredHeading = wrapDeg(headingTo(frame, frame.targetPoint) + 180);
    } else if (metres > preferred + tolerance) {
      desiredHeading = headingTo(frame, frame.targetPoint);
    }
  } else if (head === "route") {
    const routePoint = neuralV2RoutePoint(frame.actor, frame.targetPoint, action);
    desiredHeading = headingTo(frame, routePoint);
  }

  return {
    heading: wrapDeg(frame.heading + clamp(wrapDeg(desiredHeading - frame.heading), -turnRate * seconds, turnRate * seconds)),
    speed: frame.speed + clamp(desiredSpeed - frame.speed, -acceleration * seconds, acceleration * seconds),
  };
}

function applyMotion(frame, desired, seconds, runtime, isolatedHead = null) {
  const baseX = Number(frame.entity.x) || frame.x;
  const baseY = Number(frame.entity.y) || frame.y;
  const baseHeading = Number(frame.entity.heading) || frame.heading;
  const baseSpeed = Number(frame.entity.speed) || 0;
  let nextX = frame.x + Math.sin(rad(desired.heading)) * desired.speed * seconds;
  let nextY = frame.y - Math.cos(rad(desired.heading)) * desired.speed * seconds;
  let waterClamped = false;
  if (frame.actor.kind === "boat") {
    const safeX = clamp(nextX, WATER_MIN_X, WATER_MAX_X);
    const safeY = clamp(nextY, WATER_MIN_Y, WATER_MAX_Y);
    waterClamped = safeX !== nextX || safeY !== nextY;
    nextX = safeX;
    nextY = safeY;
  } else {
    nextX = clamp(nextX, 5, 415);
    nextY = clamp(nextY, 5, 315);
  }
  if (isolatedHead) {
    const effect = runtime.diagnostics.isolatedHeadEffects[isolatedHead];
    const headingDelta = Math.abs(wrapDeg(desired.heading - baseHeading));
    const speedDelta = Math.abs(desired.speed - baseSpeed);
    const positionDelta = Math.hypot(nextX - baseX, nextY - baseY);
    effect.frames += 1;
    effect.headingDeltaTotal += headingDelta;
    effect.speedDeltaTotal += speedDelta;
    effect.positionDeltaTotal += positionDelta;
    if (headingDelta > 0.001 || speedDelta > 0.001 || positionDelta > 0.0001) effect.changedFrames += 1;
  }
  frame.entity.heading = desired.heading;
  frame.entity.speed = desired.speed;
  frame.entity.x = nextX;
  frame.entity.y = nextY;
  runtime.diagnostics.movementFrames += 1;
  if (waterClamped) {
    runtime.diagnostics.waterClampFrames += 1;
    runtime.diagnostics.waterGuardInterventions += 1;
  }
}

export function finishServerNeuralV2Overrides(serverRoom, frames, dt) {
  if (!frames?.length) return {controlled: 0};
  const runtime = ensureRuntime(serverRoom);
  let controlled = 0;
  for (const frame of frames) {
    const entity = frame.entity;
    if (!entity || entity.active === false || entity.destroyed || entity.sunk) continue;
    if (frame.actor.kind === "foot" && frame.state != null && entity.state !== frame.state) continue;
    const seconds = Math.max(0, Number(dt) || 0);

    if (frame.action.isolated) {
      runtime.diagnostics.isolatedHeadFrames[frame.action.head] += frame.action.head === "fire" ? 0 : 1;
      if (frame.action.head !== "fire" && frame.actor.controlsMovement !== false) {
        applyMotion(frame, isolatedMotion(frame, seconds), seconds, runtime, frame.action.head);
      }
      controlled += 1;
      continue;
    }

    const desired = neuralV2DesiredMotion(frame.actor, frame.targetPoint, frame.action);
    if (frame.actor.controlsFire !== false) {
      if (desired.fire) runtime.diagnostics.fireAllowedFrames += 1;
      else if (suppressFire(entity)) runtime.diagnostics.fireSuppressedFrames += 1;
    }
    if (frame.actor.controlsMovement !== false) applyMotion(frame, desired, seconds, runtime);
    controlled += 1;
  }
  runtime.diagnostics.controlledFrames += controlled;
  return {controlled};
}

export function neuralV2OverrideStatus(serverRoom) {
  const runtime = serverRoom?.neuralV2OverrideRuntime;
  const diagnostics = runtime ? structuredClone(ensureRuntime(serverRoom).diagnostics) : blankDiagnostics();
  return {
    enabled: Boolean(runtime?.actions?.size),
    actionCount: runtime?.actions?.size || 0,
    actions: neuralV2OverrideSnapshot(serverRoom),
    diagnostics,
  };
}
