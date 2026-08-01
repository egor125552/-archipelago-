"use strict";

import {
  collectNeuralActors,
  neuralControlEnabled,
  neuralDecision,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "./free-roam-neural-shadow.js";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = degrees => degrees * Math.PI / 180;
const headingTo = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;

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

function desiredMotion(actor, targetPoint, decision) {
  const entity = actor.entity;
  const targetHeading = headingTo(entity, targetPoint);
  const distance = Math.hypot((Number(targetPoint?.x) || 0) - (Number(entity?.x) || 0), (Number(targetPoint?.y) || 0) - (Number(entity?.y) || 0));
  const maximum = roleSpeed(actor);
  if (decision.movement === "hold") return {heading: Number(entity.heading) || targetHeading, speed: 0};
  if (decision.movement === "retreat") return {heading: wrapDeg(targetHeading + 180), speed: maximum * 0.92};
  if (decision.movement === "flank_left") return {heading: wrapDeg(targetHeading - 78), speed: maximum * 0.82};
  if (decision.movement === "flank_right") return {heading: wrapDeg(targetHeading + 78), speed: maximum * 0.82};
  const closeScale = distance < 14 ? 0.25 : distance < 28 ? 0.58 : 1;
  return {heading: targetHeading, speed: maximum * closeScale};
}

function suppressFire(entity) {
  if (!entity) return;
  if (Number.isFinite(entity.fireCooldown)) entity.fireCooldown = Math.max(entity.fireCooldown, 0.28);
  if (Number.isFinite(entity.shotCooldown)) entity.shotCooldown = Math.max(entity.shotCooldown, 0.28);
  if (Number.isFinite(entity.attackCooldown)) entity.attackCooldown = Math.max(entity.attackCooldown, 0.28);
  if (Number.isFinite(entity.aimRemaining)) entity.aimRemaining = 0;
  if (Number.isFinite(entity.burstRemaining)) entity.burstRemaining = 0;
  if (Number.isFinite(entity.burstShotsRemaining)) entity.burstShotsRemaining = 0;
}

export function prepareServerNeuralControl(serverRoom) {
  if (!neuralControlEnabled(serverRoom) || !serverRoom?.world) return null;
  const frames = [];
  for (const actor of collectNeuralActors(serverRoom.world)) {
    const decision = neuralDecision(serverRoom, actor.id);
    if (!decision || decision.confidence < 0.25) continue;
    const targetEntry = neuralTargetForActor(serverRoom.world, actor);
    const targetPoint = targetEntry?.player ? neuralPlayerPoint(serverRoom.world, targetEntry.player) : null;
    if (!targetPoint) continue;
    if (!decision.fire) suppressFire(actor.entity);
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
      targetPoint: {x: Number(targetPoint.x) || 0, y: Number(targetPoint.y) || 0},
      decision,
    });
  }
  return frames;
}

export function finishServerNeuralControl(serverRoom, frames, dt) {
  if (!frames?.length || !neuralControlEnabled(serverRoom)) return {controlled: 0, fallback: 0};
  let controlled = 0;
  let fallback = 0;
  for (const frame of frames) {
    const entity = frame.entity;
    if (!entity || entity.active === false || entity.destroyed || entity.sunk) continue;
    if (frame.kind === "foot" && frame.state != null && entity.state !== frame.state) {
      fallback += 1;
      continue;
    }
    const desired = desiredMotion(frame, frame.targetPoint, frame.decision);
    const turnRate = frame.kind === "foot" ? 260 : 115;
    const acceleration = frame.kind === "foot" ? 28 : 15;
    const nextHeading = wrapDeg(frame.heading + clamp(wrapDeg(desired.heading - frame.heading), -turnRate * dt, turnRate * dt));
    const nextSpeed = frame.speed + clamp(desired.speed - frame.speed, -acceleration * dt, acceleration * dt);
    const radians = rad(nextHeading);
    let nextX = frame.x + Math.sin(radians) * nextSpeed * dt;
    let nextY = frame.y - Math.cos(radians) * nextSpeed * dt;
    if (frame.kind === "boat") {
      nextX = clamp(nextX, 10, 410);
      nextY = clamp(nextY, 82, 310);
    } else {
      nextX = clamp(nextX, 5, 415);
      nextY = clamp(nextY, 5, 315);
    }
    entity.heading = nextHeading;
    entity.speed = nextSpeed;
    entity.x = nextX;
    entity.y = nextY;
    controlled += 1;
  }
  return {controlled, fallback};
}
