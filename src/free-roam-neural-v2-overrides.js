"use strict";

import {
  collectNeuralActors,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "./free-roam-neural-shadow.js";
import {neuralV2DesiredMotion} from "./free-roam-neural-v2-control.js";
import {normalizeNeuralV2Action} from "./free-roam-neural-v2-schema.js";

const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = degrees => Number(degrees) * Math.PI / 180;

function ensureRuntime(serverRoom) {
  if (!serverRoom.neuralV2OverrideRuntime) {
    Object.defineProperty(serverRoom, "neuralV2OverrideRuntime", {
      value: {
        actions: new Map(),
        diagnostics: {
          preparedFrames: 0,
          controlledFrames: 0,
          movementFrames: 0,
          fireAllowedFrames: 0,
          fireSuppressedFrames: 0,
          waterClampFrames: 0,
          waterGuardInterventions: 0,
          missingActorFrames: 0,
          missingTargetFrames: 0,
        },
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const runtime = serverRoom.neuralV2OverrideRuntime;
  if (!(runtime.actions instanceof Map)) runtime.actions = new Map();
  runtime.diagnostics ||= {};
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
  return runtime;
}

export function setServerNeuralV2Override(serverRoom, actorId, rawAction) {
  if (!serverRoom || !actorId) return false;
  const runtime = ensureRuntime(serverRoom);
  if (rawAction == null) {
    runtime.actions.delete(String(actorId));
    return true;
  }
  runtime.actions.set(String(actorId), normalizeNeuralV2Action({...rawAction, source: rawAction.source || "server-test"}));
  return true;
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
      runtime.diagnostics.missingActorFrames = (runtime.diagnostics.missingActorFrames || 0) + 1;
      continue;
    }
    const targetEntry = neuralTargetForActor(serverRoom.world, actor);
    const targetPoint = targetEntry?.player ? neuralPlayerPoint(serverRoom.world, targetEntry.player) : null;
    if (!targetPoint) {
      runtime.diagnostics.missingTargetFrames = (runtime.diagnostics.missingTargetFrames || 0) + 1;
      continue;
    }
    frames.push({
      id,
      actor,
      entity: actor.entity,
      action,
      x: Number(actor.entity?.x) || 0,
      y: Number(actor.entity?.y) || 0,
      heading: Number(actor.entity?.heading) || 0,
      speed: Number(actor.entity?.speed) || 0,
      state: actor.entity?.state ?? null,
      targetPoint: {x: Number(targetPoint.x) || 0, y: Number(targetPoint.y) || 0},
    });
  }
  runtime.diagnostics.preparedFrames = (runtime.diagnostics.preparedFrames || 0) + frames.length;
  return frames;
}

export function finishServerNeuralV2Overrides(serverRoom, frames, dt) {
  if (!frames?.length) return {controlled: 0};
  const runtime = ensureRuntime(serverRoom);
  let controlled = 0;
  for (const frame of frames) {
    const entity = frame.entity;
    if (!entity || entity.active === false || entity.destroyed || entity.sunk) continue;
    if (frame.actor.kind === "foot" && frame.state != null && entity.state !== frame.state) continue;
    const desired = neuralV2DesiredMotion(frame.actor, frame.targetPoint, frame.action);

    if (frame.actor.controlsFire !== false) {
      if (desired.fire) runtime.diagnostics.fireAllowedFrames = (runtime.diagnostics.fireAllowedFrames || 0) + 1;
      else if (suppressFire(entity)) runtime.diagnostics.fireSuppressedFrames = (runtime.diagnostics.fireSuppressedFrames || 0) + 1;
    }

    if (frame.actor.controlsMovement === false) {
      controlled += 1;
      continue;
    }
    const seconds = Math.max(0, Number(dt) || 0);
    const turnRate = frame.actor.kind === "foot" ? 280 : frame.actor.role === "heavy" ? 75 : 125;
    const acceleration = frame.actor.kind === "foot" ? 30 : frame.actor.role === "heavy" ? 8 : 16;
    const nextHeading = wrapDeg(frame.heading + clamp(wrapDeg(desired.heading - frame.heading), -turnRate * seconds, turnRate * seconds));
    const nextSpeed = frame.speed + clamp(desired.speed - frame.speed, -acceleration * seconds, acceleration * seconds);
    let nextX = frame.x + Math.sin(rad(nextHeading)) * nextSpeed * seconds;
    let nextY = frame.y - Math.cos(rad(nextHeading)) * nextSpeed * seconds;
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
    entity.heading = nextHeading;
    entity.speed = nextSpeed;
    entity.x = nextX;
    entity.y = nextY;
    runtime.diagnostics.movementFrames = (runtime.diagnostics.movementFrames || 0) + 1;
    if (waterClamped) {
      runtime.diagnostics.waterClampFrames = (runtime.diagnostics.waterClampFrames || 0) + 1;
      runtime.diagnostics.waterGuardInterventions = (runtime.diagnostics.waterGuardInterventions || 0) + 1;
    }
    controlled += 1;
  }
  runtime.diagnostics.controlledFrames = (runtime.diagnostics.controlledFrames || 0) + controlled;
  return {controlled};
}

export function neuralV2OverrideStatus(serverRoom) {
  const runtime = serverRoom?.neuralV2OverrideRuntime;
  const diagnostics = runtime ? structuredClone(ensureRuntime(serverRoom).diagnostics) : {
    preparedFrames: 0,
    controlledFrames: 0,
    movementFrames: 0,
    fireAllowedFrames: 0,
    fireSuppressedFrames: 0,
    waterClampFrames: 0,
    waterGuardInterventions: 0,
    missingActorFrames: 0,
    missingTargetFrames: 0,
  };
  return {
    enabled: Boolean(runtime?.actions?.size),
    actionCount: runtime?.actions?.size || 0,
    actions: neuralV2OverrideSnapshot(serverRoom),
    diagnostics,
  };
}
