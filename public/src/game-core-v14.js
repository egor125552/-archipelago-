"use strict";

import * as base from "./game-core-v13.js?base=6";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  engineServiceDuration: 4,
  engineServiceMaxWater: 35,
  engineServiceMaxSpeed: 0.25,
  engineFloodStallWater: 80,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function deny(state, message, reason) {
  state.message = message;
  return {ok: false, reason, events: [{type: "ui-deny"}]};
}

function ensureV14State(state) {
  if (!state || typeof state !== "object") return state;
  state.crew ||= {};
  if (typeof state.crew.pumpAssistEnabled !== "boolean") state.crew.pumpAssistEnabled = false;
  state.engineService ||= {};
  state.engineService.managed = true;
  if (typeof state.engineService.active !== "boolean") state.engineService.active = false;
  if (!Number.isFinite(state.engineService.progress)) state.engineService.progress = 0;
  if (!Number.isInteger(state.engineService.lastQuarter)) state.engineService.lastQuarter = 0;
  state.damageControl ||= {};
  if (typeof state.damageControl.engineFlooded !== "boolean") state.damageControl.engineFlooded = false;
  return state;
}

function canUseSystems(state, actor) {
  return state.mode !== "coop" || actor === "crew";
}

function togglePumpAssist(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция сейчас не активна.", "not-playing");
  if (state.mode !== "solo") {
    return deny(state, "В совместной игре насосом управляет второй игрок; скрытого помощника нет.", "solo-only");
  }
  if (!canUseSystems(state, actor)) return deny(state, "Насос закреплён за системным оператором.", "crew-only");
  state.crew.pumpAssistEnabled = !state.crew.pumpAssistEnabled;
  state.message = state.crew.pumpAssistEnabled
    ? "Автооткачка помощника включена. Он запустит более медленный насос только после 34 процентов воды; ручной насос всё равно сильнее."
    : "Автооткачка помощника выключена. Теперь вода будет подниматься до полного затопления, пока ты сам не включишь насос.";
  return {ok: true, events: [{type: "pump-assist-toggle", enabled: state.crew.pumpAssistEnabled}]};
}

function beginEngineService(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция сейчас не активна.", "not-playing");
  if (!canUseSystems(state, actor)) return deny(state, "Ремонт выполняет системный оператор.", "crew-only");
  if (state.engineService.active) {
    state.message = `Обслуживание двигателя уже идёт: ${Math.round(state.engineService.progress)} процентов.`;
    return {ok: true, events: []};
  }
  if (!state.boat.engineStalled && state.boat.engineTemp < 92) {
    return deny(state, "Двигатель исправен; обслуживание сейчас не требуется.", "not-needed");
  }
  if (state.damageControl?.floodEmergency) {
    return deny(state, "Мотор под водой. Сначала откачай воду и укрепи корпус.", "flood-first");
  }
  if (state.boat.water > CONFIG.engineServiceMaxWater) {
    return deny(state, `В моторном отсеке слишком много воды: ${Math.round(state.boat.water)} процентов. Откачай до ${CONFIG.engineServiceMaxWater} или ниже.`, "water-high");
  }
  if (state.boat.fuel <= 0.01) {
    return deny(state, "Без топлива исправный мотор всё равно не запустится.", "no-fuel");
  }
  if (Math.abs(state.boat.speed) > CONFIG.engineServiceMaxSpeed) {
    return deny(state, "Для обслуживания двигателя полностью останови лодку.", "too-fast");
  }

  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.boat.engineStalled = true;
  state.boat.repairProgress = 0;
  state.engineService.active = true;
  state.engineService.progress = 0;
  state.engineService.lastQuarter = 0;
  state.message = `Обслуживание двигателя началось. Оно займёт ${CONFIG.engineServiceDuration} секунды; лодка должна оставаться сухой и неподвижной.`;
  return {ok: true, events: [{type: "engine-service-start"}]};
}

function cancelEngineService(state, events, reason, message) {
  if (!state.engineService.active) return;
  state.engineService.active = false;
  state.engineService.progress = 0;
  state.engineService.lastQuarter = 0;
  state.boat.repairProgress = 0;
  state.boat.engineStalled = true;
  state.message = message;
  events.push({type: "engine-service-cancel", reason});
}

function processEngineService(state, dt, events) {
  if (!state.engineService.active) return;
  if (state.phase !== "playing") {
    state.engineService.active = false;
    state.engineService.progress = 0;
    state.boat.repairProgress = 0;
    return;
  }
  if (state.damageControl?.floodEmergency) {
    cancelEngineService(state, events, "flood-emergency", "Обслуживание прервано: лодка снова в аварийном состоянии. Сначала откачай воду и укрепи корпус.");
    return;
  }
  if (state.boat.water > CONFIG.engineServiceMaxWater) {
    cancelEngineService(state, events, "water-high", `Обслуживание прервано: вода поднялась выше ${CONFIG.engineServiceMaxWater} процентов. Оставь насос включённым.`);
    return;
  }
  if (Math.abs(state.boat.speed) > CONFIG.engineServiceMaxSpeed) {
    cancelEngineService(state, events, "moving", "Обслуживание прервано: лодка сдвинулась. Полностью остановись и начни снова.");
    return;
  }
  if (state.boat.fuel <= 0.01) {
    cancelEngineService(state, events, "no-fuel", "Обслуживание прервано: топливо закончилось.");
    return;
  }

  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.boat.engineStalled = true;
  state.engineService.progress = clamp(
    state.engineService.progress + dt / CONFIG.engineServiceDuration * 100,
    0,
    100,
  );
  state.boat.repairProgress = state.engineService.progress;
  const quarter = Math.min(4, Math.floor(state.engineService.progress / 25));
  if (quarter > state.engineService.lastQuarter && quarter < 4) {
    state.engineService.lastQuarter = quarter;
    state.message = `Обслуживание двигателя: ${quarter * 25} процентов.`;
    events.push({type: "engine-service-progress", percent: quarter * 25});
  }
  if (state.engineService.progress < 100) return;

  state.engineService.active = false;
  state.engineService.progress = 100;
  state.engineService.lastQuarter = 4;
  state.boat.repairProgress = 0;
  state.boat.engineStalled = false;
  state.boat.engineTemp = 52;
  state.message = "Обслуживание завершено. Двигатель запущен; можно продолжать движение.";
  events.push({type: "repair-complete", source: "engine-service"});
}

function applyEngineFlooding(state, events) {
  if (state.phase !== "playing" || state.damageControl?.floodEmergency) return;
  if (state.boat.water < CONFIG.engineFloodStallWater) {
    if (state.boat.water <= CONFIG.engineServiceMaxWater) state.damageControl.engineFlooded = false;
    return;
  }
  if (state.boat.engineStalled) return;
  state.damageControl.engineFlooded = true;
  state.boat.engineStalled = true;
  state.boat.throttle = 0;
  state.controls.forward = false;
  state.message = `Вода достигла ${Math.round(state.boat.water)} процентов и залила моторный отсек. Двигатель заглох: включи насос, откачай до ${CONFIG.engineServiceMaxWater} процентов и затем обслужи мотор.`;
  events.push({type: "engine-flooded", water: state.boat.water});
}

export function createGame(options = {}) {
  return ensureV14State(base.createGame(options));
}

export function startGame(state) {
  ensureV14State(state);
  base.startGame(state);
  if (state.phase === "playing" && state.mode === "solo") {
    state.message += " Автооткачка помощника по умолчанию выключена и включается отдельной кнопкой.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV14State(state);
  if (active && state.engineService.active && ["forward", "reverse"].includes(control)) {
    state.message = "Сначала дождись окончания обслуживания двигателя.";
    return false;
  }
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV14State(state);
  if (action === "pump-assist-toggle") return togglePumpAssist(state, actor);
  if (action === "repair") return beginEngineService(state, actor);
  return base.command(state, action, actor);
}

export function step(state, dt) {
  ensureV14State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const events = base.step(state, safeDt) || [];
  applyEngineFlooding(state, events);
  if (events.some(event => event.type === "flood-emergency-start")) {
    state.controls.rescue = false;
    state.boat.rescueActive = false;
  }
  processEngineService(state, safeDt, events);
  return events;
}

export function getView(state) {
  ensureV14State(state);
  const view = base.getView(state);
  let repairReason = null;
  if (state.engineService.active) repairReason = "in-progress";
  else if (state.damageControl?.floodEmergency) repairReason = "flood-first";
  else if (state.boat.water > CONFIG.engineServiceMaxWater) repairReason = "water-high";
  else if (state.boat.fuel <= 0.01) repairReason = "no-fuel";
  else if (Math.abs(state.boat.speed) > CONFIG.engineServiceMaxSpeed) repairReason = "too-fast";
  return {
    ...view,
    quickLabel: state.damageControl?.floodEmergency ? "АВАРИЯ: ПЛАСТИНА И НАСОС" : view.quickLabel,
    canRepair: Boolean(view.canRepair && !repairReason),
    repairReason: view.canRepair ? repairReason : null,
    pumpAssist: {
      available: state.mode === "solo",
      enabled: state.mode === "solo" && state.crew.pumpAssistEnabled,
      threshold: 34,
    },
    engineService: {
      active: state.engineService.active,
      progress: state.engineService.progress,
      duration: CONFIG.engineServiceDuration,
      maxWater: CONFIG.engineServiceMaxWater,
      maxSpeed: CONFIG.engineServiceMaxSpeed,
    },
    engineFlooded: state.damageControl.engineFlooded,
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV14State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV14State(state));
}

export function deserialize(value) {
  return ensureV14State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
