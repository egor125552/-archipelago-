"use strict";

import * as base from "./game-core-v5.js?base=5";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  coastDecay: 0.028,
  sonarCooldown: 1.6,
  navigationCueInterval: 2.4,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const STEER_NO_FLOW_MESSAGE = "Руль переложен, но лодка почти стоит. Дай немного газа, чтобы корпус начал поворачивать.";

function now(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function ensureV6State(state) {
  if (!state || typeof state !== "object") return state;
  state.navigation ||= {};
  if (typeof state.navigation.assistEnabled !== "boolean") state.navigation.assistEnabled = state.mode !== "coop";
  if (!("lockedTargetId" in state.navigation)) state.navigation.lockedTargetId = null;
  if (!Number.isFinite(state.navigation.nextCueAt)) state.navigation.nextCueAt = 0;
  if (!Number.isFinite(state.navigation.steerWarningAt)) state.navigation.steerWarningAt = -999;
  if (typeof state.navigation.steerWarningActive !== "boolean") state.navigation.steerWarningActive = false;
  return state;
}

function resolveObjective(state, id = state.navigation.lockedTargetId) {
  if (id === "harbor") return {...state.world.harbor, id: "harbor", kind: "гавань"};
  const survivor = state.world.survivors.find(item => item.id === id && !item.rescued);
  if (survivor) return {...survivor, kind: "человек"};
  const next = state.world.survivors
    .filter(item => !item.rescued)
    .map(item => ({...item, kind: "человек", distance: distance(state.boat, item)}))
    .sort((a, b) => a.distance - b.distance)[0];
  if (next) return next;
  return {...state.world.harbor, id: "harbor", kind: "гавань"};
}

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  return {
    distance: distance(state.boat, target),
    relative,
    pan: clamp(relative / 75, -1, 1),
  };
}

function steeringInstruction(relative) {
  const amount = Math.abs(relative);
  if (amount <= 9) return "Курс на цель удерживается.";
  const side = relative < 0 ? "влево" : "вправо";
  if (amount <= 28) return `Слегка доверни ${side}.`;
  if (amount <= 70) return `Поворачивай ${side}.`;
  return `Цель далеко сбоку: продолжай поворачивать ${side}.`;
}

function applyLongCoast(state, previousSpeed, dt, events) {
  const boat = state.boat;
  const braking = Boolean(state.controls.reverse)
    || events.some(event => event.type === "collision" || event.type === "anchor");
  const accelerating = Boolean(state.controls.forward);
  if (braking || accelerating || Math.abs(previousSpeed) < 0.08) return;
  if (Math.sign(previousSpeed) !== Math.sign(boat.speed) && Math.abs(boat.speed) > 0.05) return;
  const coasted = previousSpeed * Math.exp(-CONFIG.coastDecay * dt);
  if (Math.abs(boat.speed) < Math.abs(coasted)) boat.speed = coasted;
}

export function createGame(options = {}) {
  return ensureV6State(base.createGame(options));
}

export function startGame(state) {
  ensureV6State(state);
  base.startGame(state);
  if (state.phase === "playing" && state.navigation.assistEnabled) {
    state.message += " Навигационный помощник включён: после сонара он будет давать тихий пространственный сигнал на цель.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  return base.setControl(ensureV6State(state), control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV6State(state);
  if (action === "assist-toggle") {
    state.navigation.assistEnabled = !state.navigation.assistEnabled;
    state.navigation.nextCueAt = now(state) + 0.4;
    state.message = state.navigation.assistEnabled
      ? "Навигационный помощник включён. Сонар закрепит цель и будет подавать пространственный ориентир."
      : "Навигационный помощник выключен.";
    return {ok: true, events: [{type: "assist-toggle", enabled: state.navigation.assistEnabled}]};
  }

  const result = base.command(state, action, actor);
  if (action === "sonar" && result.ok && state.sonar.lastResult) {
    state.sonar.cooldown = CONFIG.sonarCooldown;
    state.navigation.lockedTargetId = state.sonar.lastResult.id || null;
    state.navigation.nextCueAt = now(state) + 0.7;
    state.message = `${state.message} ${steeringInstruction(state.sonar.lastResult.relativeAngle || 0)}`;
    result.events ||= [];
    result.events.push({
      type: "sonar-lock",
      pan: state.sonar.lastResult.pan || 0,
      distance: state.sonar.lastResult.distance || 0,
    });
  }
  return result;
}

export function step(state, dt) {
  ensureV6State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const previousSpeed = Number(state.boat.speed) || 0;
  const events = base.step(state, safeDt) || [];
  applyLongCoast(state, previousSpeed, safeDt, events);

  const steering = Number(state.controls.right) - Number(state.controls.left);
  if (steering && Math.abs(state.boat.speed) < 0.35 && now(state) - state.navigation.steerWarningAt > 1.4) {
    state.navigation.steerWarningAt = now(state);
    state.navigation.steerWarningActive = true;
    state.message = STEER_NO_FLOW_MESSAGE;
    events.push({type: "steer-no-flow", pan: steering < 0 ? -0.8 : 0.8});
  } else if (state.navigation.steerWarningActive && Math.abs(state.boat.speed) >= 0.7) {
    state.navigation.steerWarningActive = false;
    if (state.message === STEER_NO_FLOW_MESSAGE) {
      state.message = `Лодка набрала ход. Курс ${Math.round((state.boat.heading + 360) % 360)} градусов.`;
      events.push({type: "steer-flow", heading: state.boat.heading});
    }
  } else if (state.navigation.steerWarningActive && !steering) {
    state.navigation.steerWarningActive = false;
    if (state.message === STEER_NO_FLOW_MESSAGE) {
      state.message = "Руль отпущен.";
      events.push({type: "steer-release"});
    }
  }

  if (state.navigation.assistEnabled && state.phase === "playing" && now(state) >= state.navigation.nextCueAt) {
    const target = resolveObjective(state);
    state.navigation.lockedTargetId = target.id;
    const bearing = bearingTo(state, target);
    state.navigation.nextCueAt = now(state) + CONFIG.navigationCueInterval;
    events.push({
      type: "navigation-cue",
      pan: bearing.pan,
      distance: bearing.distance,
      relativeAngle: bearing.relative,
      kind: target.kind,
    });
  }

  return events;
}

export function getView(state) {
  ensureV6State(state);
  const view = base.getView(state);
  const target = resolveObjective(state);
  const bearing = target ? bearingTo(state, target) : null;
  return {
    ...view,
    navigation: {
      assistEnabled: state.navigation.assistEnabled,
      lockedTargetId: state.navigation.lockedTargetId,
      targetKind: target?.kind || null,
      targetDistance: bearing?.distance ?? null,
      targetRelativeAngle: bearing?.relative ?? null,
    },
  };
}

export function serialize(state) {
  return base.serialize(ensureV6State(state));
}

export function deserialize(value) {
  return ensureV6State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
