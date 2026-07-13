"use strict";

import * as base from "./game-core-v4.js?base=5";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  coastDecay: 0.055,
  rescueRadius: 14,
  rescueSpeedLimit: 4,
  rescueDuration: 2.4,
  hullRepairSpeedLimit: 1.8,
  hullRepairDuration: 3.1,
  hullRepairAmount: 22,
  leakRepairAmount: 3.2,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function ensureV5State(state) {
  if (!state || typeof state !== "object") return state;
  state.controls ||= {};
  if (typeof state.controls.hullRepair !== "boolean") state.controls.hullRepair = false;
  state.boat ||= {};
  if (!Number.isFinite(state.boat.hullRepairProgress)) state.boat.hullRepairProgress = 0;
  if (!Number.isFinite(state.boat.repairPatches)) state.boat.repairPatches = 3;
  state.feedback ||= {};
  if (!Number.isFinite(state.feedback.rescueGuideAt)) state.feedback.rescueGuideAt = -999;
  if (!Number.isFinite(state.feedback.rescueProgressAt)) state.feedback.rescueProgressAt = -999;
  if (!Number.isFinite(state.feedback.hullRepairAt)) state.feedback.hullRepairAt = -999;
  state.rescueSystemManaged = true;
  state.navigation ||= {};
  if (!Number.isFinite(state.navigation.hardBrakeUntil)) state.navigation.hardBrakeUntil = -999;
  if (!Number.isFinite(state.navigation.turnCueAt)) state.navigation.turnCueAt = -999;
  if (!Number.isFinite(state.navigation.lastCueHeading)) state.navigation.lastCueHeading = Number(state.boat.heading) || 0;
  return state;
}

function totalTime(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function nearest(state) {
  return base.nearestSurvivor(state);
}

function canCrewOperate(state, actor) {
  return state.mode !== "coop" || actor === "crew";
}

export function createGame(options = {}) {
  return ensureV5State(base.createGame(options));
}

export function startGame(state) {
  ensureV5State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message += " Для спасения подойди к человеку ближе четырнадцати метров, сбрось скорость до четырёх узлов и один раз подай трос.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV5State(state);
  if (control === "hullRepair") {
    if (!canCrewOperate(state, actor)) {
      state.message = "Заделкой пробоины занимается системный оператор.";
      return false;
    }
    state.controls.hullRepair = Boolean(active);
    if (active) {
      if (state.boat.repairPatches <= 0) state.message = "Ремонтные пластины закончились.";
      else if (state.boat.leak <= 0.05 && state.boat.hull >= 99) state.message = "Корпус цел, заделывать нечего.";
      else if (Math.abs(state.boat.speed) > CONFIG.hullRepairSpeedLimit) state.message = `Слишком быстро для ремонта корпуса. Снизь скорость ниже ${CONFIG.hullRepairSpeedLimit.toFixed(1)} узла.`;
      else state.message = "Заделка пробоины началась. Удерживай ремонт до фиксации пластины.";
    }
    return true;
  }
  const accepted = base.setControl(state, control, active, actor);
  if (accepted && control === "rescue" && active) {
    const target = nearest(state);
    if (target && target.distance <= CONFIG.rescueRadius && Math.abs(state.boat.speed) <= CONFIG.rescueSpeedLimit) {
      state.controls.forward = false;
      state.controls.reverse = false;
      state.boat.throttle = 0;
      state.boat.speed = 0;
      state.message = "Трос зафиксирован. Лодка удерживается на месте; дождись сообщения «Человек на борту».";
    }
  }
  return accepted;
}

export function command(state, action, actor = "captain") {
  ensureV5State(state);
  if (action === "hull-repair") {
    const active = !state.controls.hullRepair;
    const ok = setControl(state, "hullRepair", active, actor);
    return {ok, events: ok && active ? [{type: "hull-repair-start"}] : []};
  }

  if (action === "quick" && canCrewOperate(state, actor)) {
    const target = nearest(state);
    const nearTarget = target && target.distance <= CONFIG.rescueRadius + 1;
    if (!nearTarget && state.boat.water <= 12 && (state.boat.leak > 0.05 || state.boat.hull < 99)) {
      const ok = setControl(state, "hullRepair", true, actor);
      return {ok, events: ok ? [{type: "hull-repair-start"}] : [{type: "ui-deny"}]};
    }
  }

  const result = base.command(state, action, actor);
  if (action === "anchor" || result.events?.some(event => event.type === "anchor")) {
    state.navigation.hardBrakeUntil = totalTime(state) + 2.2;
  }
  return result;
}

function applyCoasting(state, previousSpeed, dt, events) {
  const boat = state.boat;
  const hardBrake = totalTime(state) < state.navigation.hardBrakeUntil;
  const braking = Boolean(state.controls.reverse) || hardBrake || events.some(event => event.type === "collision");
  const accelerating = Boolean(state.controls.forward);
  if (braking || accelerating || Math.abs(previousSpeed) < 0.08) return;
  if (Math.sign(previousSpeed) !== Math.sign(boat.speed) && Math.abs(boat.speed) > 0.05) return;

  const coasted = previousSpeed * Math.exp(-CONFIG.coastDecay * dt);
  if (Math.abs(boat.speed) < Math.abs(coasted)) boat.speed = coasted;
}

function processRescue(state, dt, events, rescueRequested) {
  const boat = state.boat;
  const target = nearest(state);
  boat.rescueActive = Boolean(rescueRequested);
  if (!rescueRequested) {
    // Letting go of the rope loses the partial pull instead of banking an
    // invisible checkpoint that can be completed through repeated taps.
    for (const survivor of state.world.survivors) {
      if (!survivor.rescued) survivor.progress = Math.max(0, survivor.progress - dt * 0.8);
    }
    return;
  }

  if (!target) {
    state.controls.rescue = false;
    boat.rescueActive = false;
    state.message = "Все люди уже на борту. Теперь найди гавань.";
    return;
  }

  const now = totalTime(state);
  if (target.distance > CONFIG.rescueRadius) {
    target.survivor.progress = Math.max(0, target.survivor.progress - dt * 0.35);
    if (now - state.feedback.rescueGuideAt > 1.2) {
      state.feedback.rescueGuideAt = now;
      state.message = `Трос не достаёт. До человека ${Math.round(target.distance)} метров; подойди ближе четырнадцати.`;
      events.push({type: "rope-far", distance: target.distance});
    }
    return;
  }

  if (Math.abs(boat.speed) > CONFIG.rescueSpeedLimit) {
    target.survivor.progress = Math.max(0, target.survivor.progress - dt * 0.45);
    if (now - state.feedback.rescueGuideAt > 1.2) {
      state.feedback.rescueGuideAt = now;
      state.message = `Трос натянут, но скорость ${Math.abs(boat.speed).toFixed(1)} узла. Снизь её ниже ${CONFIG.rescueSpeedLimit.toFixed(1)}.`;
      events.push({type: "rope-strain", speed: Math.abs(boat.speed)});
    }
    return;
  }

  const previous = target.survivor.progress;
  state.controls.forward = false;
  state.controls.reverse = false;
  boat.throttle = 0;
  boat.speed = 0;
  const assist = state.mode === "solo" ? 1.22 : 1;
  target.survivor.progress = clamp(previous + dt * assist, 0, CONFIG.rescueDuration);
  const previousQuarter = Math.floor(previous / CONFIG.rescueDuration * 4);
  const currentQuarter = Math.floor(target.survivor.progress / CONFIG.rescueDuration * 4);
  if (currentQuarter > previousQuarter && currentQuarter < 4) {
    const percent = currentQuarter * 25;
    state.message = `Трос держится. Спасение: ${percent} процентов.`;
    events.push({type: "rope-progress", percent});
  }

  if (target.survivor.progress >= CONFIG.rescueDuration) {
    target.survivor.rescued = true;
    state.rescued += 1;
    state.score += 500;
    state.controls.rescue = false;
    boat.rescueActive = false;
    state.message = `Человек на борту. Спасено: ${state.rescued} из 2.`;
    events.push({type: "rescue-complete"});
  }
}

function processHullRepair(state, dt, events) {
  const boat = state.boat;
  if (!state.controls.hullRepair) return;
  const now = totalTime(state);

  if (boat.repairPatches <= 0) {
    state.controls.hullRepair = false;
    boat.hullRepairProgress = 0;
    state.message = "Ремонтные пластины закончились.";
    events.push({type: "ui-deny"});
    return;
  }
  if (boat.leak <= 0.05 && boat.hull >= 99) {
    state.controls.hullRepair = false;
    boat.hullRepairProgress = 0;
    state.message = "Корпус уже цел.";
    return;
  }
  if (Math.abs(boat.speed) > CONFIG.hullRepairSpeedLimit) {
    boat.hullRepairProgress = Math.max(0, boat.hullRepairProgress - dt * 0.7);
    if (now - state.feedback.hullRepairAt > 1.4) {
      state.feedback.hullRepairAt = now;
      state.message = `Ремонт сорвался: скорость ${Math.abs(boat.speed).toFixed(1)} узла. Почти останови лодку.`;
      events.push({type: "repair-blocked"});
    }
    return;
  }

  boat.hullRepairProgress += dt;
  const percent = Math.min(99, Math.floor(boat.hullRepairProgress / CONFIG.hullRepairDuration * 100));
  if (now - state.feedback.hullRepairAt > 1.1) {
    state.feedback.hullRepairAt = now;
    state.message = `Заделка пробоины: ${percent} процентов.`;
    events.push({type: "hull-repair-progress", percent});
  }

  if (boat.hullRepairProgress >= CONFIG.hullRepairDuration) {
    boat.hull = clamp(boat.hull + CONFIG.hullRepairAmount, 0, 100);
    boat.leak = clamp(boat.leak - CONFIG.leakRepairAmount, 0, 16);
    boat.repairPatches -= 1;
    boat.hullRepairProgress = 0;
    state.controls.hullRepair = false;
    state.score += 90;
    state.message = `Пластина закреплена. Корпус ${Math.round(boat.hull)} процентов, комплектов осталось ${boat.repairPatches}. Воду всё ещё нужно откачать насосом.`;
    events.push({type: "hull-repair-complete", patches: boat.repairPatches});
  }
}

function addTurnFeedback(state, dt, events) {
  const steer = Number(state.controls.right) - Number(state.controls.left);
  if (!steer || state.phase !== "playing") return;
  const speedFactor = clamp(Math.abs(state.boat.speed) / 4, 0.55, 1.3);
  state.boat.heading = wrapDeg(state.boat.heading + steer * 0.13 * speedFactor * dt * 60 * Math.sign(state.boat.speed || 1));
  const change = Math.abs(wrapDeg(state.boat.heading - state.navigation.lastCueHeading));
  const now = totalTime(state);
  if (change >= 15 && now - state.navigation.turnCueAt > 0.55) {
    state.navigation.turnCueAt = now;
    state.navigation.lastCueHeading = state.boat.heading;
    events.push({type: "turn-progress", direction: steer < 0 ? "left" : "right", heading: state.boat.heading, pan: steer < 0 ? -0.82 : 0.82});
  }
}

export function step(state, dt) {
  ensureV5State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const previousSpeed = Number(state.boat.speed) || 0;
  const rescueRequested = Boolean(state.controls.rescue);

  state.controls.rescue = false;
  const events = base.step(state, safeDt) || [];
  state.controls.rescue = rescueRequested;

  applyCoasting(state, previousSpeed, safeDt, events);
  addTurnFeedback(state, safeDt, events);
  processRescue(state, safeDt, events, rescueRequested);
  processHullRepair(state, safeDt, events);
  return events;
}

export function getView(state) {
  ensureV5State(state);
  const view = base.getView(state);
  const target = nearest(state);
  const rescueProgress = target ? clamp(target.survivor.progress / CONFIG.rescueDuration, 0, 1) : 0;
  let quickLabel = view.quickLabel;
  const roleCanUseSystems = state.mode !== "coop" || state.role === "crew";
  if (roleCanUseSystems && target && target.distance <= CONFIG.rescueRadius + 1) {
    quickLabel = Math.abs(state.boat.speed) > CONFIG.rescueSpeedLimit ? "Сначала снизить скорость" : "Подать спасательный трос";
  } else if (roleCanUseSystems && state.boat.water > 12) quickLabel = "Включить насос";
  else if (roleCanUseSystems && (state.boat.leak > 0.05 || state.boat.hull < 99)) quickLabel = "Заделать пробоину";

  return {
    ...view,
    quickLabel,
    rescueProgress,
    rescueRadius: CONFIG.rescueRadius,
    rescueSpeedLimit: CONFIG.rescueSpeedLimit,
    boat: {
      ...view.boat,
      rudder: state.boat.rudder,
      hullRepairProgress: state.boat.hullRepairProgress,
      repairPatches: state.boat.repairPatches,
      hullRepairActive: state.controls.hullRepair,
      rescueActive: state.controls.rescue,
    },
    canRepairHull: state.boat.repairPatches > 0 && (state.boat.leak > 0.05 || state.boat.hull < 99),
  };
}

export function serialize(state) {
  return base.serialize(ensureV5State(state));
}

export function deserialize(value) {
  return ensureV5State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
