"use strict";

import * as base from "./game-core-v14.js?base=6";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  waterEngineRestartWater: 35,
  waterEngineRestartDelay: 1.2,
  voiceMessageLimit: 105,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ensureV15State(state) {
  if (!state || typeof state !== "object") return state;
  state.waterEngine ||= {};
  if (typeof state.waterEngine.locked !== "boolean") {
    // Migrate dry v14 saves: a water-stalled engine lost its engineFlooded
    // marker as soon as the bilge reached 35%, although it was still stalled.
    const legacyWaterStall = Boolean(
      state.boat?.engineStalled
      && !state.engineService?.active
      && state.boat?.fuel > 0.01
      && state.boat?.engineTemp < 92,
    );
    state.waterEngine.locked = Boolean(
      state.damageControl?.floodEmergency
      || state.damageControl?.engineFlooded
      || legacyWaterStall,
    );
  }
  if (!Number.isFinite(state.waterEngine.restartProgress)) state.waterEngine.restartProgress = 0;
  if (!state.waterEngine.reason) {
    state.waterEngine.reason = state.waterEngine.locked
      ? (state.damageControl?.emergencyCause === "wrecked" ? "safety" : "water")
      : null;
  }
  return state;
}

function canUseSystems(state, actor) {
  return state.mode !== "coop" || actor === "crew";
}

function deny(state, message, reason) {
  state.message = message;
  return {ok: false, reason, events: [{type: "ui-deny"}]};
}

function capMessage(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= CONFIG.voiceMessageLimit) return clean;
  const slice = clean.slice(0, CONFIG.voiceMessageLimit - 1);
  const boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary > 65 ? boundary : slice.length)}…`;
}

function directionText(angle) {
  if (!Number.isFinite(angle) || Math.abs(angle) < 10) return "прямо";
  return angle < 0 ? "слева" : "справа";
}

function objectiveName(state) {
  const id = state.navigation?.lockedTargetId || state.sonar?.lastResult?.id;
  if (id === "survivor-a") return "первый человек";
  if (id === "survivor-b") return "второй человек";
  if (id === "harbor") return "гавань";
  return state.riskRoute?.active ? "проход" : "цель";
}

function emergencyAction(state, seconds = null) {
  const needsPlate = state.boat.hull < CONFIG.floodRecoveryHull;
  const needsPump = state.boat.water > CONFIG.floodRecoveryWater;
  const prefix = Number.isFinite(seconds) ? `${seconds} секунд. ` : "";
  const plate = state.controls.hullRepair
    ? "Пластина ставится."
    : state.boat.repairPatches > 0 ? "Поставь пластину." : "Пластин нет.";
  const pump = !state.boat.pumpActive
    ? "Включи насос."
    : state.mode === "solo" && !state.controls.pump
      ? "Включи ручной насос."
      : "Не выключай насос.";
  if (needsPlate && needsPump) return `${prefix}${plate} ${pump}`;
  if (needsPlate) return `${prefix}${plate}`;
  if (needsPump) return `${prefix}${pump}`;
  return `${prefix}Лодка стабилизируется.`;
}

function compactSonar(state) {
  const result = state.sonar?.lastResult;
  if (!result) return "Сонар не нашёл цель.";
  if (result.kind === "clear") return "Сонар: рядом чисто.";
  const label = result.routeIsWaypoint || state.riskRoute?.active ? "проход" : objectiveName(state);
  return `Сонар: ${label} ${directionText(result.relativeAngle)}, ${Math.round(result.distance || 0)} метров.`;
}

function restartWaterEngine(state, events = []) {
  state.waterEngine.locked = false;
  state.waterEngine.reason = null;
  state.waterEngine.restartProgress = 0;
  state.damageControl.engineFlooded = false;
  state.engineService.active = false;
  state.engineService.progress = 0;
  state.boat.repairProgress = 0;
  state.boat.engineStalled = false;
  state.boat.engineTemp = Math.min(Number(state.boat.engineTemp) || 52, 55);
  state.message = "Мотор запущен.";
  events.push({type: "engine-water-restart"});
}

function lockWaterEngine(state, reason = "water") {
  state.waterEngine.locked = true;
  state.waterEngine.reason = reason;
  state.waterEngine.restartProgress = 0;
  state.boat.engineStalled = true;
  state.boat.throttle = 0;
  state.controls.forward = false;
  state.controls.reverse = false;
}

function updateWaterEngine(state, dt, events) {
  const floodStart = events.find(event => event.type === "flood-emergency-start");
  if (events.some(event => event.type === "engine-flooded")) lockWaterEngine(state, "water");
  if (floodStart) lockWaterEngine(state, floodStart.cause === "flooded" ? "water" : "safety");
  if (!state.waterEngine.locked || state.phase !== "playing") return;

  state.boat.engineStalled = true;
  state.boat.throttle = 0;
  const ready = !state.damageControl?.floodEmergency
    && state.boat.water <= CONFIG.waterEngineRestartWater
    && state.boat.hull >= CONFIG.floodRecoveryHull
    && state.boat.fuel > 0.01
    && state.boat.engineTemp < 92;
  if (!ready) {
    state.waterEngine.restartProgress = 0;
    return;
  }
  state.waterEngine.restartProgress += dt;
  if (state.waterEngine.restartProgress >= CONFIG.waterEngineRestartDelay) restartWaterEngine(state, events);
}

function compactCommandMessage(state, action, result) {
  if (action === "sonar") {
    state.message = result.ok ? compactSonar(state) : capMessage(state.message);
  } else if (action === "risk-route-toggle" && result.ok) {
    state.message = state.riskRoute.selectedRisk ? "Рискованный маршрут выбран. Нажми сонар." : "Обычный маршрут выбран. Нажми сонар.";
  } else if (action === "pump-assist-toggle" && result.ok) {
    state.message = state.crew.pumpAssistEnabled ? "Автооткачка включена." : "Автооткачка выключена.";
  } else if (action === "anchor" && result.ok) {
    state.message = "Плавучий тормоз сброшен.";
  } else if (action === "hull-repair" && result.ok) {
    state.message = state.controls.hullRepair ? "Ремонт корпуса начат." : "Ремонт корпуса отменён.";
  } else if (action === "safety-toggle" && result.ok) {
    state.message = state.training.safetyEnabled ? "Страховка включена." : "Страховка выключена.";
  } else if (action === "assist-toggle" && result.ok) {
    state.message = state.navigation.assistEnabled ? "Маяк включён." : "Маяк выключен.";
  } else {
    state.message = capMessage(state.message);
  }
}

function compactStepMessage(state, events, previousMessage) {
  const has = type => events.some(event => event.type === type);
  const event = type => events.find(item => item.type === type);
  if (has("win")) {
    const reward = Number(state.progression?.rewardCredits) || 0;
    state.message = reward ? `Операция завершена. Награда: ${reward} жетонов.` : "Операция завершена.";
  } else if (has("flood-emergency-failed")) {
    state.message = "Аварийное время вышло. Лодка потеряна.";
  } else if (has("lose")) {
    state.message = state.ending === "fuel" ? "Топливо кончилось. Операция завершена." : "Операция провалена.";
  } else if (has("flood-emergency-start")) {
    state.message = `Авария. ${emergencyAction(state, CONFIG.floodEmergencySeconds)}`;
  } else if (has("flood-emergency-warning")) {
    state.message = emergencyAction(state, event("flood-emergency-warning").seconds);
  } else if (has("flood-emergency-recovered")) {
    state.message = state.boat.fuel <= 0.01
      ? "Лодка стабилизирована. Нет топлива."
      : state.boat.engineTemp >= 92
        ? "Лодка стабилизирована. Обслужи мотор."
        : "Лодка стабилизирована. Мотор запускается.";
  } else if (has("engine-water-restart")) {
    state.message = "Мотор запущен.";
  } else if (has("engine-flooded")) {
    state.message = `Мотор залит. Откачай воду до ${CONFIG.waterEngineRestartWater} процентов.`;
  } else if (has("collision")) {
    const hit = event("collision");
    state.message = `Удар. Корпус минус ${Math.round(hit.damage || 0)} процентов.`;
  } else if (has("rescue-complete")) {
    state.message = `Человек на борту. ${state.rescued} из 2.`;
  } else if (has("hull-repair-complete")) {
    state.message = `Пластина готова. Корпус ${Math.round(state.boat.hull)} процентов.`;
  } else if (has("repair-complete")) {
    state.message = "Мотор запущен.";
  } else if (has("engine-service-cancel")) {
    state.message = "Ремонт мотора прерван.";
  } else if (has("engine-stall")) {
    state.message = "Мотор перегрелся. Остановись и обслужи его.";
  } else if (has("risk-gate-entered")) {
    state.message = "Вход пройден. Держи маяк по центру.";
  } else if (has("risk-gate-cleared")) {
    state.message = "Проход чистый. Бонус получен.";
  } else if (has("risk-gate-failed")) {
    state.message = "Проход завершён без бонуса.";
  } else if (has("course-hold")) {
    state.message = "Курс захвачен. Руль можно отпустить.";
  } else if (has("approach-assist")) {
    state.message = "Цель рядом. Газ снят.";
  } else if (has("docking-assist")) {
    state.message = "Гавань рядом. Скорость снижена.";
  } else if (has("safety-brake")) {
    state.message = "Стоп. Впереди препятствие.";
  } else if (has("rope-far")) {
    state.message = `Трос не достаёт. ${Math.round(event("rope-far").distance || 0)} метров.`;
  } else if (has("rope-strain")) {
    state.message = "Слишком быстро для троса.";
  } else if (events.some(item => ["rope-progress", "hull-repair-progress", "engine-service-progress"].includes(item.type))) {
    state.message = previousMessage;
  } else if (state.message !== previousMessage) {
    state.message = capMessage(state.message);
  }
}

export function createGame(options = {}) {
  return ensureV15State(base.createGame(options));
}

export function startGame(state) {
  ensureV15State(state);
  base.startGame(state);
  if (state.phase === "playing") state.message = `Уровень ${state.progression?.level || 1}. Нажми сонар.`;
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV15State(state);
  const pressing = Boolean(active);
  const captainAllowed = state.mode !== "coop" || actor === "captain";
  if (pressing && state.damageControl?.floodEmergency && control === "rescue") {
    state.message = emergencyAction(state);
    return false;
  }
  if (pressing && captainAllowed && ["forward", "reverse"].includes(control) && state.waterEngine.locked) {
    if (state.damageControl?.floodEmergency || state.boat.hull < CONFIG.floodRecoveryHull) {
      state.message = "Ход заблокирован. Сначала стабилизируй лодку.";
      return false;
    }
    if (state.boat.water > CONFIG.waterEngineRestartWater) {
      state.message = `Мотор залит. Вода должна быть не выше ${CONFIG.waterEngineRestartWater} процентов.`;
      return false;
    }
    if (state.boat.fuel <= 0.01) {
      state.message = "Нет топлива.";
      return false;
    }
    if (state.boat.engineTemp >= 92) {
      state.waterEngine.locked = false;
      state.message = "Мотор перегрет. Обслужи его.";
      return false;
    }
    restartWaterEngine(state);
  }

  if (pressing && canUseSystems(state, actor)) {
    if (control === "rescue" && (state.controls.hullRepair || state.engineService.active)) {
      state.message = state.controls.hullRepair ? "Сначала закончи корпус." : "Сначала закончи мотор.";
      return false;
    }
    if (control === "hullRepair" && (state.controls.rescue || state.engineService.active)) {
      state.message = state.controls.rescue ? "Сначала закончи спасение." : "Сначала закончи мотор.";
      return false;
    }
  }

  const accepted = base.setControl(state, control, active, actor);
  if (accepted && pressing && control === "rescue") state.message = "Трос подан.";
  else if (accepted && pressing && control === "hullRepair") state.message = "Ремонт корпуса начат.";
  else if (!accepted) state.message = capMessage(state.message);
  return accepted;
}

export function command(state, action, actor = "captain") {
  ensureV15State(state);
  if (state.damageControl?.floodEmergency && ["sonar", "risk-route-toggle", "quick"].includes(action)) {
    return deny(state, action === "quick" ? emergencyAction(state) : "Сначала стабилизируй лодку.", "emergency-priority");
  }
  if (action === "repair" && (state.controls.rescue || state.controls.hullRepair)) {
    return deny(state, "Сначала закончи текущее действие.", "busy");
  }
  if (action === "repair" && state.waterEngine.locked) {
    if (!canUseSystems(state, actor)) return deny(state, "Ремонт выполняет оператор.", "crew-only");
    if (state.damageControl?.floodEmergency || state.boat.hull < CONFIG.floodRecoveryHull) {
      return deny(state, "Сначала стабилизируй лодку.", "flood-first");
    }
    if (state.boat.water > CONFIG.waterEngineRestartWater) {
      return deny(state, `Откачай воду до ${CONFIG.waterEngineRestartWater} процентов.`, "water-high");
    }
    if (state.boat.fuel <= 0.01) return deny(state, "Нет топлива.", "no-fuel");
    if (state.boat.engineTemp >= 92) {
      state.waterEngine.locked = false;
    } else {
      const events = [];
      restartWaterEngine(state, events);
      return {ok: true, events};
    }
  }
  if (action === "hull-repair" && (state.controls.rescue || state.engineService.active)) {
    return deny(state, "Системный оператор занят.", "busy");
  }

  const result = base.command(state, action, actor);
  compactCommandMessage(state, action, result);
  return result;
}

export function step(state, dt) {
  ensureV15State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const previousMessage = state.message;
  const events = base.step(state, safeDt) || [];
  updateWaterEngine(state, safeDt, events);
  compactStepMessage(state, events, previousMessage);
  return events;
}

export function getView(state) {
  ensureV15State(state);
  const view = base.getView(state);
  const canRestart = state.waterEngine.locked
    && !state.damageControl?.floodEmergency
    && state.boat.water <= CONFIG.waterEngineRestartWater
    && state.boat.hull >= CONFIG.floodRecoveryHull
    && state.boat.fuel > 0.01
    && state.boat.engineTemp < 92;
  const canService = state.waterEngine.locked
    && !state.damageControl?.floodEmergency
    && state.boat.water <= CONFIG.waterEngineRestartWater
    && state.boat.hull >= CONFIG.floodRecoveryHull
    && state.boat.fuel > 0.01
    && state.boat.engineTemp >= 92
    && Math.abs(state.boat.speed) <= CONFIG.engineServiceMaxSpeed;
  let waterRepairReason = null;
  if (state.damageControl?.floodEmergency || state.boat.hull < CONFIG.floodRecoveryHull) waterRepairReason = "flood-first";
  else if (state.boat.water > CONFIG.waterEngineRestartWater) waterRepairReason = "water-high";
  else if (state.boat.fuel <= 0.01) waterRepairReason = "no-fuel";
  else if (state.boat.engineTemp >= 92) waterRepairReason = "overheated";
  else waterRepairReason = "water-restart";
  return {
    ...view,
    quickLabel: state.damageControl?.floodEmergency
      ? emergencyAction(state).replace(/\.$/, "").toUpperCase()
      : view.quickLabel,
    canRepair: state.waterEngine.locked ? canService : view.canRepair,
    repairReason: state.waterEngine.locked ? waterRepairReason : view.repairReason,
    engineFlooded: state.waterEngine.locked && state.waterEngine.reason === "water",
    engineStoppedByEmergency: state.waterEngine.locked && state.waterEngine.reason === "safety",
    waterEngine: {
      locked: state.waterEngine.locked,
      reason: state.waterEngine.reason,
      restartWater: CONFIG.waterEngineRestartWater,
      restartProgress: clamp(state.waterEngine.restartProgress / CONFIG.waterEngineRestartDelay, 0, 1),
      canRestart,
      canService,
    },
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV15State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV15State(state));
}

export function deserialize(value) {
  return ensureV15State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
