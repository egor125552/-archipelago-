"use strict";

import * as base from "./game-core-v8.js?base=1";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  motionStartSpeed: 0.45,
  motionStopSpeed: 0.16,
  repairGraceSeconds: 45,
  floodGraceMultiplier: 0.32,
  floodNormalMultiplier: 0.68,
  beginnerBrakeDistance: 18,
  beginnerBrakeSpeed: 5.5,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function clock(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function ensureV9State(state) {
  if (!state || typeof state !== "object") return state;
  state.damageControl ||= {};
  if (!Number.isFinite(state.damageControl.graceUntil)) state.damageControl.graceUntil = -999;
  if (!Number.isFinite(state.damageControl.firstLeakAt)) state.damageControl.firstLeakAt = -999;
  if (typeof state.damageControl.warnedTwenty !== "boolean") state.damageControl.warnedTwenty = false;
  if (typeof state.damageControl.warnedEight !== "boolean") state.damageControl.warnedEight = false;

  state.motion ||= {};
  if (typeof state.motion.moving !== "boolean") {
    state.motion.moving = Math.abs(Number(state.boat?.speed) || 0) >= CONFIG.motionStartSpeed;
  }

  state.training ||= {};
  if (typeof state.training.safetyEnabled !== "boolean") state.training.safetyEnabled = state.mode !== "coop";
  if (!Number.isFinite(state.training.lastBrakeAt)) state.training.lastBrakeAt = -999;
  return state;
}

function relativeBearing(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  return wrapDeg(absolute - state.boat.heading);
}

function nearestHazardAhead(state) {
  return state.world.hazards
    .map(hazard => ({hazard, distance: distance(state.boat, hazard), relative: relativeBearing(state, hazard)}))
    .filter(item => Math.abs(item.relative) <= 28)
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function startRepairWindow(state, events) {
  const now = clock(state);
  state.damageControl.firstLeakAt = state.damageControl.firstLeakAt < 0 ? now : state.damageControl.firstLeakAt;
  state.damageControl.graceUntil = Math.max(state.damageControl.graceUntil, now + CONFIG.repairGraceSeconds);
  state.damageControl.warnedTwenty = false;
  state.damageControl.warnedEight = false;
  state.message += ` Аварийный запас плавучести даёт ${CONFIG.repairGraceSeconds} секунд, чтобы остановиться, поставить пластину и включить насос.`;
  events.push({type: "repair-window-start", seconds: CONFIG.repairGraceSeconds});
}

function slowFlooding(state, previousWater) {
  if (state.boat.water <= previousWater || state.boat.pumpActive) return;
  const now = clock(state);
  const scale = now < state.damageControl.graceUntil
    ? CONFIG.floodGraceMultiplier
    : CONFIG.floodNormalMultiplier;
  state.boat.water = previousWater + (state.boat.water - previousWater) * scale;
}

function restorePrematureFloodLoss(state, events) {
  if (!state.lost || state.ending !== "flooded" || state.boat.water >= 100) return;
  state.lost = false;
  state.won = false;
  state.ending = null;
  state.phase = "playing";
  state.message = "Лодка ещё держится. Немедленно заделай пробоину и включи насос.";
  events.splice(0, events.length, ...events.filter(event => event.type !== "lose"));
}

function applyBeginnerSafety(state, dt, events) {
  if (!state.training.safetyEnabled || state.mode !== "solo" || state.phase !== "playing") return;
  const hazard = nearestHazardAhead(state);
  const speed = Math.abs(state.boat.speed);
  if (!hazard || hazard.distance > CONFIG.beginnerBrakeDistance || speed < CONFIG.beginnerBrakeSpeed) return;

  const urgency = clamp((CONFIG.beginnerBrakeDistance - hazard.distance) / CONFIG.beginnerBrakeDistance, 0.15, 1);
  state.boat.throttle = Math.min(state.boat.throttle, 0.18);
  state.boat.speed *= Math.exp(-(0.75 + urgency * 1.35) * dt);

  const now = clock(state);
  if (now - state.training.lastBrakeAt > 5.5) {
    state.training.lastBrakeAt = now;
    state.message = `Учебная страховка сбросила газ: впереди ${hazard.hazard.label || "препятствие"}, ${Math.round(hazard.distance)} метров. Обойди его рулём.`;
    events.push({type: "safety-brake", pan: hazard.relative < 0 ? -0.65 : 0.65});
  }
}

function settleAtRest(state) {
  const noDrive = !state.controls.forward && !state.controls.reverse && Math.abs(state.boat.throttle) < 0.045;
  if (noDrive && Math.abs(state.boat.speed) < CONFIG.motionStopSpeed) {
    state.boat.speed = 0;
    state.boat.throttle = 0;
  }
  state.world.current = {x: 0, y: 0};
  state.world.storm = {intensity: 0, target: 0};
}

function updateMotionState(state, events) {
  const speed = Math.abs(state.boat.speed);
  if (!state.motion.moving && speed >= CONFIG.motionStartSpeed) {
    state.motion.moving = true;
    events.push({type: "motion-start", speed});
  } else if (state.motion.moving && speed <= CONFIG.motionStopSpeed) {
    state.motion.moving = false;
    events.push({type: "motion-stop"});
  }
}

function updateRepairWindowWarnings(state, events) {
  const remaining = state.damageControl.graceUntil - clock(state);
  if (remaining <= 0) return;
  if (remaining <= 8 && !state.damageControl.warnedEight) {
    state.damageControl.warnedEight = true;
    state.message = "Аварийный запас почти исчерпан: восемь секунд. Пластина и насос нужны сейчас.";
    events.push({type: "repair-window-warning", seconds: 8, critical: true});
  } else if (remaining <= 20 && !state.damageControl.warnedTwenty) {
    state.damageControl.warnedTwenty = true;
    state.message = "До окончания аварийного запаса двадцать секунд. Снизь ход, заделай пробоину и включи насос.";
    events.push({type: "repair-window-warning", seconds: 20, critical: false});
  }
}

export function createGame(options = {}) {
  const state = ensureV9State(base.createGame(options));
  state.world.current = {x: 0, y: 0};
  state.world.storm = {intensity: 0, target: 0};
  state.boat.speed = 0;
  state.boat.throttle = 0;
  state.motion.moving = false;
  return state;
}

export function startGame(state) {
  ensureV9State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message = "Лодка стоит в тихой речной бухте без течения. Тихие редкие всплески означают стоянку; отчётливый кильватер появляется только на ходу. Нажми сонар один раз, чтобы закрепить первого человека.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  return base.setControl(ensureV9State(state), control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV9State(state);
  if (action === "safety-toggle") {
    state.training.safetyEnabled = !state.training.safetyEnabled;
    state.message = `Учебная страховка ${state.training.safetyEnabled ? "включена: перед близким препятствием она мягко сбросит газ" : "выключена"}.`;
    return {ok: true, events: [{type: "safety-toggle", enabled: state.training.safetyEnabled}]};
  }
  const result = base.command(state, action, actor);
  if (action === "where" && result.ok) {
    const speed = Math.abs(state.boat.speed);
    const movement = speed <= CONFIG.motionStopSpeed ? "Лодка стоит" : speed < 2 ? "Лодка медленно дрейфует по инерции" : "Лодка идёт";
    state.message = `${movement}. ${state.message}`;
  }
  return result;
}

export function step(state, dt) {
  ensureV9State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const previousWater = Number(state.boat.water) || 0;
  const previousLeak = Number(state.boat.leak) || 0;
  let events = base.step(state, safeDt) || [];

  const newDamage = events.some(event => event.type === "collision") && state.boat.leak > previousLeak + 0.01;
  if (newDamage) startRepairWindow(state, events);

  slowFlooding(state, previousWater);
  restorePrematureFloodLoss(state, events);
  applyBeginnerSafety(state, safeDt, events);
  settleAtRest(state);
  updateMotionState(state, events);
  updateRepairWindowWarnings(state, events);
  return events;
}

export function getView(state) {
  ensureV9State(state);
  const view = base.getView(state);
  const speed = Math.abs(state.boat.speed);
  const remaining = Math.max(0, state.damageControl.graceUntil - clock(state));
  const motionState = speed <= CONFIG.motionStopSpeed ? "стоит" : speed < 2 ? "дрейфует" : "идёт";
  return {
    ...view,
    training: {
      safetyEnabled: state.training.safetyEnabled,
    },
    damageControl: {
      repairWindowRemaining: remaining,
      repairWindowActive: remaining > 0,
      waterIngressActive: state.boat.leak > 0.05 && !state.boat.pumpActive,
    },
    boat: {
      ...view.boat,
      motionState,
      moving: state.motion.moving,
    },
  };
}

export function serialize(state) {
  return base.serialize(ensureV9State(state));
}

export function deserialize(value) {
  return ensureV9State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
