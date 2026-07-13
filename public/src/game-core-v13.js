"use strict";

import * as base from "./game-core-v12.js?base=4";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  riskGateReachRadius: 3,
  riskGateScoreBonus: 150,
  riskGateCreditBonus: 100,
  engineRepairSpeedLimit: 2.2,
  emergencyRestartGrace: 8,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const SOUTH_NORTHBOUND = Object.freeze([
  Object.freeze({id: "risk-south-entry", gateKey: "south-wreck-gap", label: "вход в узкий проход у обломков баржи", x: 14.5, y: 26, award: false}),
  Object.freeze({id: "risk-south-north-exit", gateKey: "south-wreck-gap", label: "северный выход из прохода у обломков баржи", x: 14.5, y: 42, award: true}),
]);

const SOUTH_SOUTHBOUND = Object.freeze([
  Object.freeze({id: "risk-south-north-entry", gateKey: "south-wreck-gap", label: "северный вход в проход у обломков баржи", x: 14.5, y: 42, award: false}),
  Object.freeze({id: "risk-south-exit", gateKey: "south-wreck-gap", label: "выход к Южной гавани", x: 14.5, y: 26, award: true}),
]);

const NORTH_NORTHBOUND = Object.freeze([
  Object.freeze({id: "risk-north-entry", gateKey: "north-wreck-gap", label: "вход в узкий проход у затонувшего катера", x: 19.5, y: 62, award: false}),
  Object.freeze({id: "risk-north-exit", gateKey: "north-wreck-gap", label: "северный выход из прохода у затонувшего катера", x: 19.5, y: 78, award: true}),
]);

const NORTH_SOUTHBOUND = Object.freeze([
  Object.freeze({id: "risk-north-return-entry", gateKey: "north-wreck-gap", label: "северный вход в проход у затонувшего катера", x: 19.5, y: 78, award: false}),
  Object.freeze({id: "risk-north-return-exit", gateKey: "north-wreck-gap", label: "южный выход из прохода у затонувшего катера", x: 19.5, y: 62, award: true}),
]);

// These are opt-in challenge lines. The normal sonar never uses them and
// continues to guide the broad, direct corridors introduced in v11.
const RISK_ROUTES = Object.freeze({
  2: Object.freeze({
    "survivor-a": SOUTH_NORTHBOUND,
    "survivor-b": Object.freeze([]),
    harbor: SOUTH_SOUTHBOUND,
  }),
  3: Object.freeze({
    "survivor-a": SOUTH_NORTHBOUND,
    "survivor-b": NORTH_NORTHBOUND,
    harbor: Object.freeze([...NORTH_SOUTHBOUND, ...SOUTH_SOUTHBOUND]),
  }),
});

function clock(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function objectiveFor(state, id = state.navigation?.lockedTargetId) {
  if (id === "harbor" && state.rescued >= 2) return {...state.world.harbor, kind: "гавань"};
  const survivor = state.world.survivors.find(item => item.id === id && !item.rescued);
  return survivor ? {...survivor, kind: "человек"} : null;
}

function objectiveLabel(target) {
  if (!target) return "цель";
  if (target.id === "survivor-a") return "первый человек";
  if (target.id === "survivor-b") return "второй человек";
  if (target.id === "harbor") return "Южная гавань";
  return target.label || "цель";
}

function objectiveDative(target) {
  if (!target) return "цели";
  if (target.id === "survivor-a") return "первому человеку";
  if (target.id === "survivor-b") return "второму человеку";
  if (target.id === "harbor") return "Южной гавани";
  return target.label || "цели";
}

function directionText(relative) {
  if (Math.abs(relative) <= CONFIG.navigationCenterTolerance) return "прямо";
  const side = relative < 0 ? "слева" : "справа";
  return Math.abs(relative) <= 32 ? `чуть ${side}` : side;
}

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  const centered = Math.abs(relative) <= CONFIG.navigationCenterTolerance;
  const pan = centered
    ? 0
    : clamp((relative - Math.sign(relative) * CONFIG.navigationCenterTolerance) / (82 - CONFIG.navigationCenterTolerance), -1, 1);
  return {absolute, relative, centered, pan, distance: distance(state.boat, target)};
}

function routeFor(state, targetId) {
  const level = state.progression?.level || 1;
  return (RISK_ROUTES[level]?.[targetId] || []).map(point => ({
    ...point,
    kind: "рискованный проход",
    finalId: targetId,
  }));
}

function ensureV13State(state) {
  if (!state || typeof state !== "object") return state;
  state.riskRoute ||= {};
  if (typeof state.riskRoute.enabled !== "boolean") state.riskRoute.enabled = false;
  if (typeof state.riskRoute.selectedRisk !== "boolean") state.riskRoute.selectedRisk = state.riskRoute.enabled;
  if (!("targetId" in state.riskRoute)) state.riskRoute.targetId = null;
  if (!Number.isInteger(state.riskRoute.stage) || state.riskRoute.stage < 0) state.riskRoute.stage = 0;
  if (typeof state.riskRoute.gateFailed !== "boolean") state.riskRoute.gateFailed = false;
  if (!Array.isArray(state.riskRoute.clearedKeys)) state.riskRoute.clearedKeys = [];
  state.riskRoute.clearedKeys = [...new Set(state.riskRoute.clearedKeys.filter(key => typeof key === "string"))];
  if (!Number.isFinite(state.riskRoute.creditBonus)) state.riskRoute.creditBonus = 0;
  if (!Number.isFinite(state.riskRoute.scoreBonus)) state.riskRoute.scoreBonus = 0;
  if (!Number.isFinite(state.riskRoute.cleanGates)) state.riskRoute.cleanGates = state.riskRoute.clearedKeys.length;
  state.releaseFixes ||= {};
  if (typeof state.releaseFixes.scoreTimeCorrected !== "boolean") state.releaseFixes.scoreTimeCorrected = false;
  return state;
}

function resetRiskTarget(state, targetId) {
  state.riskRoute.targetId = targetId || null;
  state.riskRoute.stage = 0;
  state.riskRoute.gateFailed = false;
}

function syncRiskTarget(state) {
  if (!state.riskRoute.enabled) return null;
  const objective = objectiveFor(state);
  if (!objective) return null;
  if (state.riskRoute.targetId !== objective.id) resetRiskTarget(state, objective.id);
  return objective;
}

function currentRiskGate(state) {
  const objective = syncRiskTarget(state);
  if (!objective) return null;
  const route = routeFor(state, objective.id);
  return state.riskRoute.stage < route.length ? route[state.riskRoute.stage] : null;
}

function deny(state, message, reason) {
  state.message = message;
  return {ok: false, reason, events: [{type: "ui-deny"}]};
}

function recordEvent(state, type, text, data = {}) {
  state.eventLog ||= [];
  state.eventLog.push({time: Number(clock(state).toFixed(2)), type, text, data});
  state.eventLog = state.eventLog.slice(-40);
}

function toggleRiskRoute(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция сейчас не активна.", "not-playing");
  if ((state.progression?.level || 1) < 2) {
    return deny(state, "Рискованные маршруты открываются на втором уровне.", "locked");
  }
  if (state.mode === "coop" && actor !== "crew") {
    return deny(state, "Режим маршрута выбирает системный оператор рядом с сонаром.", "crew-only");
  }

  state.riskRoute.selectedRisk = !state.riskRoute.selectedRisk;
  state.message = state.riskRoute.selectedRisk
    ? `Выбран рискованный режим. Нажми сонар, чтобы применить его к закреплённой цели. Только после этого маяк поведёт через озвученные вход и выход узкого прохода; чистые ворота дадут ${CONFIG.riskGateScoreBonus} очков и ${CONFIG.riskGateCreditBonus} жетонов после победы. Текущий маяк пока не изменён.`
    : "Выбран обычный режим. Нажми сонар, чтобы применить прямой маршрут и удержание курса. Текущий маяк пока не изменён.";
  return {ok: true, events: [{type: "risk-route-toggle", enabled: state.riskRoute.selectedRisk}]};
}

function applyRiskSonar(state, result) {
  if (!result.ok) return result;
  state.riskRoute.enabled = state.riskRoute.selectedRisk && (state.progression?.level || 1) >= 2;
  resetRiskTarget(state, state.riskRoute.enabled ? state.navigation?.lockedTargetId : null);
  if (!state.riskRoute.enabled) return result;
  const objective = syncRiskTarget(state);
  const gate = currentRiskGate(state);
  if (!objective || !gate) {
    if (objective) state.message += " На этом отрезке рискованных ворот нет; маяк остаётся прямым.";
    return result;
  }

  const gateBearing = bearingTo(state, gate);
  const objectiveDistance = distance(state.boat, objective);
  state.navigation.courseHold = false;
  state.sonar.lastResult = {
    ...(state.sonar.lastResult || {}),
    id: objective.id,
    objectiveDistance,
    distance: gateBearing.distance,
    relativeAngle: gateBearing.relative,
    pan: gateBearing.pan,
    routeIsWaypoint: true,
  };
  state.message = `Рискованный сонар закрепил ${gate.label}: ${directionText(gateBearing.relative)}, ${Math.round(gateBearing.distance)} метров. Конечная цель — ${objectiveLabel(objective)}, ${Math.round(objectiveDistance)} метров. До ворот веди лодку вручную по высокому стереомаяку; режим не переключится сам до прохождения точки.`;
  result.events = (result.events || []).map(event => ["sonar", "sonar-lock"].includes(event.type)
    ? {
      ...event,
      pan: gateBearing.pan,
      distance: gateBearing.distance,
      relativeAngle: gateBearing.relative,
      routeIsWaypoint: true,
      riskRoute: true,
    }
    : event);
  return result;
}

function applyRiskProgress(state, events) {
  const gate = currentRiskGate(state);
  if (!gate) return;
  if (events.some(event => event.type === "collision")) {
    state.riskRoute.gateFailed = true;
    return;
  }
  if (distance(state.boat, gate) > CONFIG.riskGateReachRadius) return;

  if (!gate.award) {
    state.riskRoute.stage += 1;
    state.navigation.courseHold = false;
    const next = currentRiskGate(state);
    const nextBearing = next ? bearingTo(state, next) : null;
    state.message = next
      ? `Вход рискованного прохода пересечён. Теперь держи ${next.label} ${directionText(nextBearing.relative)}, ${Math.round(nextBearing.distance)} метров. Автоподруливание остаётся на паузе до полного выхода.`
      : "Вход рискованного прохода пересечён. Продолжай держать стереомаяк по центру до выхода.";
    events.push({type: "risk-gate-entered", gateId: gate.gateKey, pan: nextBearing?.pan || 0});
    recordEvent(state, "risk-gate-entered", state.message, {gateId: gate.gateKey});
    return;
  }

  const key = `${state.riskRoute.targetId}:${gate.gateKey}`;
  const alreadyCleared = state.riskRoute.clearedKeys.includes(key);
  const clean = !state.riskRoute.gateFailed && !alreadyCleared;
  state.riskRoute.stage += 1;
  state.riskRoute.gateFailed = false;
  state.navigation.courseHold = false;

  if (clean) {
    state.riskRoute.clearedKeys.push(key);
    state.riskRoute.cleanGates += 1;
    state.riskRoute.scoreBonus += CONFIG.riskGateScoreBonus;
    state.riskRoute.creditBonus += CONFIG.riskGateCreditBonus;
    state.score += CONFIG.riskGateScoreBonus;
  }

  const next = currentRiskGate(state);
  const objective = objectiveFor(state, state.riskRoute.targetId);
  const nextTarget = next || objective;
  const nextBearing = nextTarget ? bearingTo(state, nextTarget) : null;
  const rewardText = clean
    ? `Чистый рискованный проход: плюс ${CONFIG.riskGateScoreBonus} очков и ${CONFIG.riskGateCreditBonus} жетонов после завершения операции.`
    : alreadyCleared
      ? "Этот проход уже был засчитан; повторной награды нет."
      : "Проход пройден после столкновения, поэтому бонус не начислен.";
  const nextText = next
    ? ` Следующая рискованная точка — ${next.label} ${directionText(nextBearing.relative)}, ${Math.round(nextBearing.distance)} метров.`
    : nextTarget
      ? ` Теперь маяк ведёт прямо к ${objectiveDative(nextTarget)}; удержание прямого курса снова доступно.`
      : "";
  state.message = `${rewardText}${nextText}`;
  const type = clean ? "risk-gate-cleared" : alreadyCleared ? "risk-gate-repeat" : "risk-gate-failed";
  events.push({
    type,
    gateId: gate.gateKey,
    targetId: state.riskRoute.targetId,
    scoreBonus: clean ? CONFIG.riskGateScoreBonus : 0,
    creditBonus: clean ? CONFIG.riskGateCreditBonus : 0,
    pan: nextBearing?.pan || 0,
  });
  recordEvent(state, type, state.message, {gateId: gate.gateKey, clean});
}

function correctWinTimeScore(state, events) {
  if (state.releaseFixes.scoreTimeCorrected || !events.some(event => event.type === "win")) return;
  const trueElapsed = clock(state);
  const legacyElapsed = Number(state.elapsed) || 0;
  const fixedBonus = Math.max(0, Math.round(1200 + state.boat.hull * 8 + state.boat.fuel * 4 - trueElapsed * 2));
  const legacyBonus = Math.round(1200 + state.boat.hull * 8 + state.boat.fuel * 4 - legacyElapsed * 2);
  state.score += fixedBonus - legacyBonus;
  state.releaseFixes.scoreTimeCorrected = true;
}

function applyFuelEnding(state, events) {
  if (state.phase !== "playing" || state.won || state.lost || state.damageControl?.floodEmergency) return;
  if (state.boat.fuel > 0.01 || Math.abs(state.boat.speed) > CONFIG.motionStopSpeed) return;
  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.boat.engineStalled = true;
  state.lost = true;
  state.phase = "finished";
  state.ending = "fuel";
  state.message = "Топливо закончилось, и лодка остановилась вне гавани. Мотор нельзя запустить без топлива; операция завершена.";
  events.push({type: "lose", reason: "fuel"});
  recordEvent(state, "lose", state.message, {reason: "fuel"});
}

export function createGame(options = {}) {
  return ensureV13State(base.createGame(options));
}

export function startGame(state) {
  ensureV13State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    const routeText = (state.progression?.level || 1) < 2
      ? "Рискованные маршруты откроются на втором уровне."
      : "Рядом с сонаром можно заранее выбрать обычный или рискованный маршрут.";
    state.message += ` ${routeText}`;
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV13State(state);
  // Releases are still accepted so a disconnect or page hide can never leave
  // a held system active. New presses only make sense during a live operation.
  if (active && state.phase !== "playing") return false;
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV13State(state);
  if (action === "risk-route-toggle") return toggleRiskRoute(state, actor);

  if (state.phase === "playing" && action === "anchor" && state.mode === "coop" && actor !== "captain") {
    return deny(state, "Плавучий тормоз находится у капитана.", "captain-only");
  }

  if (state.phase === "playing" && action === "repair") {
    if (state.mode === "coop" && actor !== "crew") {
      return deny(state, "Ремонт выполняет системный оператор.", "crew-only");
    }
    const repairNeeded = state.boat.engineStalled || state.boat.engineTemp >= 92;
    if (repairNeeded && !state.damageControl?.floodEmergency && state.boat.fuel <= 0.01) {
      return deny(state, "Топливо закончилось. Ремонт исправит мотор, но не сможет запустить его без топлива.", "no-fuel");
    }
    if (repairNeeded && !state.damageControl?.floodEmergency && Math.abs(state.boat.speed) > CONFIG.engineRepairSpeedLimit) {
      return deny(state, `Ремонт двигателя опасен на ходу. Снизь скорость до ${CONFIG.engineRepairSpeedLimit.toFixed(1)} узла.`, "too-fast");
    }
  }

  const result = base.command(state, action, actor);
  return action === "sonar" ? applyRiskSonar(state, result) : result;
}

export function step(state, dt) {
  ensureV13State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const emergencyBefore = Boolean(state.timed && state.damageControl?.floodEmergency && state.phase === "playing");
  if (emergencyBefore) state.elapsed = Math.max(0, (Number(state.elapsed) || 0) - safeDt);

  const gateBefore = currentRiskGate(state);
  const savedAssist = state.navigation?.assistEnabled;
  const savedSafety = state.training?.safetyEnabled;
  if (gateBefore) {
    state.navigation.assistEnabled = false;
    state.navigation.courseHold = false;
    if (state.training) state.training.safetyEnabled = false;
  }

  const events = base.step(state, safeDt) || [];
  if (gateBefore) {
    state.navigation.assistEnabled = savedAssist;
    if (state.training) state.training.safetyEnabled = savedSafety;
  }

  if (state.timed && events.some(event => event.type === "flood-emergency-start")) {
    state.elapsed = Math.min(state.elapsed, CONFIG.missionDuration - CONFIG.emergencyRestartGrace);
  }

  correctWinTimeScore(state, events);
  if (state.phase === "playing") applyRiskProgress(state, events);
  if (events.some(event => event.type === "rescue-complete")) resetRiskTarget(state, null);
  applyFuelEnding(state, events);
  return events;
}

export function getView(state) {
  ensureV13State(state);
  const view = base.getView(state);
  const gate = currentRiskGate(state);
  const bearing = gate ? bearingTo(state, gate) : null;
  const repairReason = !view.canRepair
    ? null
    : state.damageControl?.floodEmergency
      ? "flood-first"
      : state.boat.fuel <= 0.01
        ? "no-fuel"
        : Math.abs(state.boat.speed) > CONFIG.engineRepairSpeedLimit
          ? "too-fast"
          : null;
  return {
    ...view,
    canRepair: Boolean(view.canRepair && !repairReason),
    repairReason,
    training: {
      ...view.training,
      safetySuspendedForRisk: Boolean(gate),
    },
    navigation: gate ? {
      ...view.navigation,
      directMode: false,
      courseHold: false,
      targetRelativeAngle: bearing.relative,
      guideDistance: bearing.distance,
      guidePan: bearing.pan,
      guideCentered: bearing.centered,
      guideIsWaypoint: true,
      beaconPan: bearing.pan,
      beaconCentered: bearing.centered,
      beaconSuppressed: false,
      rescueMode: false,
      routeWaypointId: gate.id,
      routeWaypointLabel: gate.label,
    } : view.navigation,
    riskRoute: {
      available: (state.progression?.level || 1) >= 2,
      selectedRisk: state.riskRoute.selectedRisk,
      enabled: state.riskRoute.enabled,
      selectionPending: state.riskRoute.selectedRisk !== state.riskRoute.enabled,
      active: Boolean(gate),
      targetId: state.riskRoute.targetId,
      stage: state.riskRoute.stage,
      gateId: gate?.id || null,
      gateLabel: gate?.label || null,
      gateFailed: state.riskRoute.gateFailed,
      cleanGates: state.riskRoute.cleanGates,
      scoreBonus: state.riskRoute.scoreBonus,
      creditBonus: state.riskRoute.creditBonus,
    },
  };
}

export function getRoutePlan(state, targetId) {
  ensureV13State(state);
  const objective = objectiveFor(state, targetId);
  if (!state.riskRoute.selectedRisk || !objective) return base.getRoutePlan(state, targetId);
  return [...routeFor(state, targetId), objective];
}

export function serialize(state) {
  return base.serialize(ensureV13State(state));
}

export function deserialize(value) {
  return ensureV13State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
