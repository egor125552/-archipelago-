"use strict";

import * as base from "./game-core-v8.js?base=1";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  motionStartSpeed: 0.45,
  motionStopSpeed: 0.16,
  floodEmergencySeconds: 32,
  floodRecoveryWater: 72,
  floodRecoveryLeak: 1.2,
  floodRecoveryHull: 5,
  regularFloodMultiplier: 0.74,
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
  if (typeof state.damageControl.floodEmergency !== "boolean") state.damageControl.floodEmergency = false;
  if (!Number.isFinite(state.damageControl.floodEmergencyUntil)) state.damageControl.floodEmergencyUntil = -999;
  if (typeof state.damageControl.warnedFifteen !== "boolean") state.damageControl.warnedFifteen = false;
  if (typeof state.damageControl.warnedFive !== "boolean") state.damageControl.warnedFive = false;

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
  const heading = state.boat.heading * Math.PI / 180;
  const forwardX = Math.sin(heading);
  const forwardY = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightY = -Math.sin(heading);
  return state.world.hazards
    .map(hazard => {
      const dx = hazard.x - state.boat.x;
      const dy = hazard.y - state.boat.y;
      const forward = dx * forwardX + dy * forwardY;
      const lateral = dx * rightX + dy * rightY;
      const radius = hazard.radius + (CONFIG.collisionMargin || 2.6) + 1.1;
      if (forward <= 0 || Math.abs(lateral) >= radius) return null;
      const corridorDepth = Math.sqrt(Math.max(0, radius * radius - lateral * lateral));
      return {
        hazard,
        clearance: Math.max(0, forward - corridorDepth),
        distance: distance(state.boat, hazard),
        relative: relativeBearing(state, hazard),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.clearance - b.clearance)[0] || null;
}

function prepareFloodEmergencyTick(state, dt) {
  if (!state.damageControl.floodEmergency) return;
  state.lost = false;
  state.won = false;
  state.ending = null;
  state.phase = "playing";
  state.boat.engineStalled = true;
  state.boat.throttle = 0;
  state.boat.speed *= Math.exp(-3.2 * dt);
  if (Math.abs(state.boat.speed) < 0.12) state.boat.speed = 0;
  // Keep the legacy engine one fraction below its instant-loss threshold.
  // The public view still reports the actual emergency water level.
  if (state.boat.water >= 99.6) state.boat.water = 99.45;
  // A zero hull and full water used to trigger the legacy instant-loss branch
  // on the next frame, making the promised repair window impossible to use.
  if (state.boat.hull <= 0) state.boat.hull = 0.05;
}

function enterOrMaintainFloodEmergency(state, events) {
  if (!state.lost || state.ending !== "flooded") return false;
  const firstEntry = !state.damageControl.floodEmergency;
  state.damageControl.floodEmergency = true;
  if (firstEntry) {
    state.damageControl.floodEmergencyUntil = clock(state) + CONFIG.floodEmergencySeconds;
    state.damageControl.warnedFifteen = false;
    state.damageControl.warnedFive = false;
  }

  state.lost = false;
  state.won = false;
  state.ending = null;
  state.phase = "playing";
  state.boat.water = 100;
  if (state.boat.hull <= 0) state.boat.hull = 0.05;
  state.boat.engineStalled = true;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.controls.forward = false;
  state.controls.reverse = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "lose") events.splice(index, 1);
  }

  if (firstEntry) {
    state.message = `Лодка полностью затоплена, но ещё держится. Есть ${CONFIG.floodEmergencySeconds} секунды: почти остановись, поставь ремонтную пластину и включи насос. Движение и мотор недоступны.`;
    events.push({type: "flood-emergency-start", seconds: CONFIG.floodEmergencySeconds});
  }
  return true;
}

function slowRegularFlooding(state, previousWater) {
  if (state.damageControl.floodEmergency || state.boat.pumpActive || state.boat.water <= previousWater) return;
  state.boat.water = previousWater + (state.boat.water - previousWater) * CONFIG.regularFloodMultiplier;
}

function finishFloodEmergency(state, events) {
  if (!state.damageControl.floodEmergency) return;
  const recovered = state.boat.water <= CONFIG.floodRecoveryWater
    && state.boat.leak <= CONFIG.floodRecoveryLeak
    && state.boat.hull >= CONFIG.floodRecoveryHull;
  if (recovered) {
    state.damageControl.floodEmergency = false;
    state.damageControl.floodEmergencyUntil = -999;
    state.boat.repairProgress = 0;
    state.message = "Лодка снова держится на плаву. Вода ниже аварийного уровня, пробоина закрыта. Теперь нажимай Проверить двигатель, пока мотор не запустится.";
    events.push({type: "flood-emergency-recovered"});
    return;
  }

  const remaining = state.damageControl.floodEmergencyUntil - clock(state);
  if (remaining <= 0) {
    state.damageControl.floodEmergency = false;
    state.lost = true;
    state.phase = "finished";
    state.ending = "flooded";
    state.message = "Аварийное время закончилось. Воду не успели откачать, лодка потеряна.";
    events.push({type: "flood-emergency-failed"}, {type: "lose"});
    return;
  }

  if (remaining <= 5 && !state.damageControl.warnedFive) {
    state.damageControl.warnedFive = true;
    state.message = "Пять секунд до потери лодки. Пластина и насос нужны немедленно.";
    events.push({type: "flood-emergency-warning", seconds: 5, critical: true});
  } else if (remaining <= 15 && !state.damageControl.warnedFifteen) {
    state.damageControl.warnedFifteen = true;
    state.message = "Пятнадцать секунд аварийного времени. Заделай пробоину и продолжай откачку.";
    events.push({type: "flood-emergency-warning", seconds: 15, critical: false});
  }
}

function applyBeginnerSafety(state, dt, events) {
  if (!state.training.safetyEnabled || state.mode !== "solo" || state.phase !== "playing" || state.damageControl.floodEmergency) return;
  const hazard = nearestHazardAhead(state);
  const speed = Math.abs(state.boat.speed);
  const stoppingDistance = Math.max(
    CONFIG.beginnerBrakeDistance,
    speed * 1.1 + speed * speed / 15,
  );
  if (!hazard || hazard.clearance > stoppingDistance || speed < CONFIG.beginnerBrakeSpeed) return;

  const urgency = clamp((stoppingDistance - hazard.clearance) / stoppingDistance, 0.15, 1);
  state.boat.throttle = Math.min(state.boat.throttle, 0.18);
  state.boat.speed *= Math.exp(-(0.75 + urgency * 1.35) * dt);

  const now = clock(state);
  if (now - state.training.lastBrakeAt > 5.5) {
    state.training.lastBrakeAt = now;
    state.message = `Учебная страховка сбросила газ: до края препятствия ${hazard.hazard.label || "препятствие"} около ${Math.round(hazard.clearance)} метров. Обойди его рулём.`;
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
  ensureV9State(state);
  if (state.damageControl.floodEmergency && active && ["forward", "reverse"].includes(control)) {
    state.message = "Лодка полностью затоплена: ход заблокирован. Сначала поставь пластину и включи насос.";
    return false;
  }
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV9State(state);
  if (action === "safety-toggle") {
    state.training.safetyEnabled = !state.training.safetyEnabled;
    state.message = `Учебная страховка ${state.training.safetyEnabled ? "включена: перед близким препятствием она мягко сбросит газ" : "выключена"}.`;
    return {ok: true, events: [{type: "safety-toggle", enabled: state.training.safetyEnabled}]};
  }
  if (action === "repair" && state.damageControl.floodEmergency) {
    state.message = "Мотор под водой и сейчас не запустится. Сначала поставь ремонтную пластину и откачай воду ниже аварийного уровня.";
    return {ok: false, reason: "flood-first", events: [{type: "ui-deny"}]};
  }
  const result = base.command(state, action, actor);
  if (action === "where" && result.ok) {
    const speed = Math.abs(state.boat.speed);
    const movement = state.damageControl.floodEmergency
      ? "Лодка полностью затоплена и аварийно остановлена"
      : speed <= CONFIG.motionStopSpeed ? "Лодка стоит" : speed < 2 ? "Лодка медленно дрейфует по инерции" : "Лодка идёт";
    state.message = `${movement}. ${state.message}`;
  }
  return result;
}

export function step(state, dt) {
  ensureV9State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  prepareFloodEmergencyTick(state, safeDt);
  const previousWater = Number(state.boat.water) || 0;
  let events = base.step(state, safeDt) || [];

  const converted = enterOrMaintainFloodEmergency(state, events);
  if (!converted) slowRegularFlooding(state, previousWater);
  applyBeginnerSafety(state, safeDt, events);
  settleAtRest(state);
  updateMotionState(state, events);
  finishFloodEmergency(state, events);
  return events;
}

export function getView(state) {
  ensureV9State(state);
  const view = base.getView(state);
  const speed = Math.abs(state.boat.speed);
  const remaining = state.damageControl.floodEmergency
    ? Math.max(0, state.damageControl.floodEmergencyUntil - clock(state))
    : 0;
  const motionState = state.damageControl.floodEmergency
    ? "аварийно остановлена"
    : speed <= CONFIG.motionStopSpeed ? "стоит" : speed < 2 ? "дрейфует" : "идёт";
  return {
    ...view,
    training: {
      safetyEnabled: state.training.safetyEnabled,
    },
    damageControl: {
      floodEmergency: state.damageControl.floodEmergency,
      floodEmergencyRemaining: remaining,
      waterIngressActive: state.boat.leak > 0.05 && !state.boat.pumpActive,
      recoveryWaterTarget: CONFIG.floodRecoveryWater,
      recoveryLeakTarget: CONFIG.floodRecoveryLeak,
      recoveryHullTarget: CONFIG.floodRecoveryHull,
    },
    boat: {
      ...view.boat,
      water: state.damageControl.floodEmergency && state.boat.water > 99 ? 100 : view.boat.water,
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
