"use strict";

import * as base from "./free-roam-core-v2.js";
import {CONFIG} from "./game-core-v18.js?free=3";

export const WORLD = base.WORLD;

const COAST_DECAY = 0.028;
const ENGINE_SERVICE_DURATION = 4;
const REFUEL_DURATION = CONFIG.emergencyFuelDuration || 4.5;
const REFUEL_AMOUNT = CONFIG.emergencyFuelAmount || 30;
const FLOATING_BRAKE_COOLDOWN = CONFIG.floatingBrakeCooldown || 12;
const MOTION_START_SPEED = CONFIG.motionStartSpeed || 0.45;
const MOTION_STOP_SPEED = CONFIG.motionStopSpeed || 0.16;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function emptyInput() {
  return {up: false, down: false, left: false, right: false, pump: false, repair: false, action: false, jump: false};
}

function copyInput(input) {
  return {
    up: Boolean(input?.up),
    down: Boolean(input?.down),
    left: Boolean(input?.left),
    right: Boolean(input?.right),
    pump: Boolean(input?.pump),
    repair: Boolean(input?.repair),
    action: Boolean(input?.action),
    jump: Boolean(input?.jump),
  };
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 120) world.events.splice(0, world.events.length - 120);
}

function ensureBoat(boat) {
  if (!boat) return;
  if (typeof boat.moving !== "boolean") boat.moving = Math.abs(Number(boat.speed) || 0) >= MOTION_START_SPEED;
  if (!Number.isFinite(boat.lastTurnCueHeading)) boat.lastTurnCueHeading = Number(boat.heading) || 0;
  if (!Number.isFinite(boat.lastTurnCueAt)) boat.lastTurnCueAt = -999;
  if (!Number.isFinite(boat.lastSteerWarningAt)) boat.lastSteerWarningAt = -999;
  if (!Number.isFinite(boat.floatingBrakeReadyAt)) boat.floatingBrakeReadyAt = 0;
  if (!Number.isInteger(boat.refuelCanisters)) boat.refuelCanisters = 1;
  if (typeof boat.refuelActive !== "boolean") boat.refuelActive = false;
  if (!Number.isFinite(boat.refuelProgress)) boat.refuelProgress = 0;
  if (!Number.isInteger(boat.refuelQuarter)) boat.refuelQuarter = 0;
  if (typeof boat.engineServiceActive !== "boolean") boat.engineServiceActive = false;
  if (!Number.isFinite(boat.engineServiceProgress)) boat.engineServiceProgress = 0;
  if (!Number.isInteger(boat.engineServiceQuarter)) boat.engineServiceQuarter = 0;
  if (typeof boat.fuelEmptyAnnounced !== "boolean") boat.fuelEmptyAnnounced = false;
}

function ensureWorld(world) {
  if (!world) return world;
  world.version = Math.max(3, Number(world.version) || 0);
  world.operationInputs ||= [emptyInput(), emptyInput()];
  world.operationPreviousInputs ||= [emptyInput(), emptyInput()];
  while (world.operationInputs.length < world.players.length) world.operationInputs.push(emptyInput());
  while (world.operationPreviousInputs.length < world.players.length) world.operationPreviousInputs.push(emptyInput());
  for (const boat of world.boats || []) ensureBoat(boat);
  return world;
}

export function createFreeWorld() {
  return ensureWorld(base.createFreeWorld());
}

export function setPlayerInput(world, playerIndex, nextInput) {
  ensureWorld(world);
  if (!world?.operationInputs?.[playerIndex]) return;
  world.operationInputs[playerIndex] = copyInput(nextInput);
  base.setPlayerInput(world, playerIndex, nextInput);
}

export const drainEvents = base.drainEvents;

function targetsForBoat(boat) {
  return [boat.driver ?? boat.owner];
}

function boatForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  return player && ["boat", "roof"].includes(player.mode) ? world.boats?.[player.activeBoat] : null;
}

function cancelRefuel(world, boat, text = "Заправка отменена.") {
  if (!boat.refuelActive) return;
  boat.refuelActive = false;
  boat.refuelProgress = 0;
  boat.refuelQuarter = 0;
  emit(world, "fuel-refuel-cancel", text, targetsForBoat(boat));
}

function cancelEngineService(world, boat, text = "Обслуживание мотора отменено.") {
  if (!boat.engineServiceActive) return;
  boat.engineServiceActive = false;
  boat.engineServiceProgress = 0;
  boat.engineServiceQuarter = 0;
  emit(world, "engine-service-cancel", text, targetsForBoat(boat));
}

function startRefuel(world, boat, playerIndex) {
  if (boat.refuelCanisters <= 0) {
    emit(world, "ui-deny", "Аварийная канистра уже израсходована.", [playerIndex]);
    return true;
  }
  if (Math.abs(boat.speed) > 0.25) {
    emit(world, "ui-deny", "Сначала полностью останови лодку.", [playerIndex]);
    return true;
  }
  if (boat.emergencyActive || boat.pumpActive || world.inputs[playerIndex]?.repair) {
    emit(world, "ui-deny", "Сначала закончи аварийные работы.", [playerIndex]);
    return true;
  }
  boat.refuelActive = true;
  boat.refuelProgress = 0;
  boat.refuelQuarter = 0;
  boat.engineStalled = true;
  boat.speed = 0;
  boat.throttle = 0;
  emit(world, "fuel-refuel-start", "Аварийная канистра подключена.", [playerIndex], {source: "canister"});
  return true;
}

function startEngineService(world, boat, playerIndex) {
  if (Math.abs(boat.speed) > 0.25) {
    emit(world, "ui-deny", "Для обслуживания полностью останови лодку.", [playerIndex]);
    return true;
  }
  if (boat.water > 35 || boat.emergencyActive) {
    emit(world, "ui-deny", "Сначала откачай воду и стабилизируй корпус.", [playerIndex]);
    return true;
  }
  boat.engineServiceActive = true;
  boat.engineServiceProgress = 0;
  boat.engineServiceQuarter = 0;
  boat.engineStalled = true;
  boat.speed = 0;
  boat.throttle = 0;
  emit(world, "engine-service-start", "Обслуживание двигателя началось.", [playerIndex]);
  return true;
}

function handleContextAction(world, playerIndex) {
  const boat = boatForPlayer(world, playerIndex);
  const player = world.players[playerIndex];
  if (!boat || player.mode !== "boat") return false;
  if (boat.refuelActive) {
    cancelRefuel(world, boat);
    return true;
  }
  if (boat.engineServiceActive) {
    cancelEngineService(world, boat);
    return true;
  }
  if (boat.fuel <= 0.01) return startRefuel(world, boat, playerIndex);
  if (boat.engineStalled && boat.engineTemp >= 92) return startEngineService(world, boat, playerIndex);
  return false;
}

function useFloatingBrake(world, playerIndex) {
  const player = world.players[playerIndex];
  const boat = boatForPlayer(world, playerIndex);
  if (!boat || player.mode !== "boat") return false;
  const remaining = boat.floatingBrakeReadyAt - world.time;
  if (remaining > 0) {
    emit(world, "ui-deny", `Плавучий тормоз восстанавливается: ${Math.ceil(remaining)} с.`, [playerIndex]);
    return true;
  }
  if (Math.abs(boat.speed) <= MOTION_STOP_SPEED && Math.abs(boat.throttle) < 0.05) {
    emit(world, "ui-deny", "Лодка уже стоит. Плавучий тормоз не израсходован.", [playerIndex]);
    return true;
  }
  const direction = Math.sign(boat.speed || 0);
  boat.speed = direction * Math.min(0.12, Math.abs(boat.speed) * 0.08);
  boat.throttle = 0;
  boat.rudder = 0;
  boat.floatingBrakeReadyAt = world.time + FLOATING_BRAKE_COOLDOWN;
  world.inputs[playerIndex].up = false;
  world.inputs[playerIndex].down = false;
  emit(world, "anchor", "Плавучий тормоз сброшен. Лодка почти остановилась.", [playerIndex]);
  return true;
}

function processRefuel(world, boat, input, dt) {
  if (!boat.refuelActive) return;
  if (boat.emergencyActive || input.up || input.down || input.pump || input.repair || Math.abs(boat.speed) > 0.25) {
    cancelRefuel(world, boat, "Заправка прервана.");
    return;
  }
  boat.engineStalled = true;
  boat.speed = 0;
  boat.throttle = 0;
  boat.refuelProgress = clamp(boat.refuelProgress + dt / REFUEL_DURATION * 100, 0, 100);
  const quarter = Math.min(4, Math.floor(boat.refuelProgress / 25));
  if (quarter > boat.refuelQuarter && quarter < 4) {
    boat.refuelQuarter = quarter;
    emit(world, "fuel-refuel-progress", `Заправка ${quarter * 25}%.`, targetsForBoat(boat), {percent: quarter * 25});
  }
  if (boat.refuelProgress < 100) return;
  boat.refuelCanisters = Math.max(0, boat.refuelCanisters - 1);
  boat.fuel = clamp(boat.fuel + REFUEL_AMOUNT, 0, 100);
  boat.refuelActive = false;
  boat.refuelProgress = 0;
  boat.refuelQuarter = 0;
  boat.fuelEmptyAnnounced = false;
  if (boat.water <= 35 && boat.hull >= 5 && boat.engineTemp < 92) boat.engineStalled = false;
  emit(world, "fuel-refuel-complete", `Заправка завершена. Топливо ${Math.round(boat.fuel)}%.`, targetsForBoat(boat), {source: "canister", fuel: boat.fuel});
}

function processEngineService(world, boat, input, dt) {
  if (!boat.engineServiceActive) return;
  if (boat.emergencyActive || boat.water > 35 || input.up || input.down || input.pump || input.repair || Math.abs(boat.speed) > 0.25) {
    cancelEngineService(world, boat, "Обслуживание прервано.");
    return;
  }
  boat.engineStalled = true;
  boat.speed = 0;
  boat.throttle = 0;
  boat.engineServiceProgress = clamp(boat.engineServiceProgress + dt / ENGINE_SERVICE_DURATION * 100, 0, 100);
  const quarter = Math.min(4, Math.floor(boat.engineServiceProgress / 25));
  if (quarter > boat.engineServiceQuarter && quarter < 4) {
    boat.engineServiceQuarter = quarter;
    emit(world, "engine-service-progress", `Обслуживание двигателя: ${quarter * 25}%.`, targetsForBoat(boat), {percent: quarter * 25});
  }
  if (boat.engineServiceProgress < 100) return;
  boat.engineServiceActive = false;
  boat.engineServiceProgress = 0;
  boat.engineServiceQuarter = 0;
  boat.engineTemp = 52;
  boat.engineStalled = false;
  emit(world, "repair-complete", "Обслуживание завершено. Двигатель запущен.", targetsForBoat(boat), {source: "engine-service"});
}

function applyOperationCoast(world, boat, input, previousSpeed, dt, newEvents) {
  if (boat.refuelActive || boat.engineServiceActive || boat.emergencyActive || input.up || input.down) return;
  if (newEvents.some(event => ["collision", "ram", "anchor"].includes(event.type))) return;
  if (Math.abs(previousSpeed) < 0.08 || Math.sign(previousSpeed) !== Math.sign(boat.speed || previousSpeed)) return;
  const coasted = previousSpeed * Math.exp(-COAST_DECAY * dt);
  if (Math.abs(boat.speed) < Math.abs(coasted)) boat.speed = coasted;
}

function addSteeringFeedback(world, boat, input) {
  const steer = Number(input.right) - Number(input.left);
  if (!steer) return;
  const targets = targetsForBoat(boat);
  if (Math.abs(boat.speed) < 0.35 && world.time - boat.lastSteerWarningAt > 1.4) {
    boat.lastSteerWarningAt = world.time;
    emit(world, "steer-no-flow", "Руль переложен, но лодка почти стоит. Дай немного газа.", targets, {pan: steer < 0 ? -0.8 : 0.8});
    return;
  }
  const change = Math.abs(wrapDeg(boat.heading - boat.lastTurnCueHeading));
  if (change >= 15 && world.time - boat.lastTurnCueAt > 0.55) {
    boat.lastTurnCueAt = world.time;
    boat.lastTurnCueHeading = boat.heading;
    emit(world, "turn-progress", "", targets, {direction: steer < 0 ? "left" : "right", heading: boat.heading, pan: steer < 0 ? -0.82 : 0.82});
  }
}

function addMotionFeedback(world, boat) {
  const speed = Math.abs(boat.speed);
  if (!boat.moving && speed >= MOTION_START_SPEED) {
    boat.moving = true;
    emit(world, "motion-start", "", targetsForBoat(boat));
  } else if (boat.moving && speed <= MOTION_STOP_SPEED) {
    boat.moving = false;
    emit(world, "motion-stop", "", targetsForBoat(boat));
  }
}

export function stepFreeWorld(world, dt) {
  ensureWorld(world);
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  const inputs = world.operationInputs.map(copyInput);
  const previousInputs = world.operationPreviousInputs.map(copyInput);
  const previousBoats = world.boats.map(boat => ({speed: boat.speed, heading: boat.heading, y: boat.y}));
  const eventStart = world.events.length;

  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const boat = boatForPlayer(world, index);
    const input = inputs[index];
    const previous = previousInputs[index];
    if (boat && player.mode === "boat") {
      if (previous.up && !input.up && boat.throttle > 0) boat.throttle = 0;
      if (previous.down && !input.down && boat.throttle < 0) boat.throttle = 0;
      if (input.jump && !previous.jump && useFloatingBrake(world, index)) world.inputs[index].jump = false;
      if (input.action && !previous.action && handleContextAction(world, index)) world.inputs[index].action = false;
      if (boat.refuelActive || boat.engineServiceActive) {
        world.inputs[index].up = false;
        world.inputs[index].down = false;
      }
    }
  }

  base.stepFreeWorld(world, safeDt);
  const newEvents = world.events.slice(eventStart);

  for (let index = 0; index < world.boats.length; index += 1) {
    const boat = world.boats[index];
    const driver = boat.driver;
    const input = driver == null ? emptyInput() : inputs[driver];
    processRefuel(world, boat, input, safeDt);
    processEngineService(world, boat, input, safeDt);
    applyOperationCoast(world, boat, input, previousBoats[index].speed, safeDt, newEvents);
    addSteeringFeedback(world, boat, input);
    addMotionFeedback(world, boat);

    if (boat.fuel <= 0.01) {
      boat.engineStalled = true;
      if (!boat.fuelEmptyAnnounced) {
        boat.fuelEmptyAnnounced = true;
        emit(world, "fuel-empty-ready", "Топливо закончилось. Остановись и нажми F для аварийной канистры.", targetsForBoat(boat), {canisters: boat.refuelCanisters});
      }
    } else boat.fuelEmptyAnnounced = false;
  }

  for (let index = 0; index < world.operationPreviousInputs.length; index += 1) {
    world.operationPreviousInputs[index] = copyInput(inputs[index]);
  }
  return world;
}

export function playerStatus(world, playerIndex) {
  ensureWorld(world);
  const text = base.playerStatus(world, playerIndex);
  const boat = boatForPlayer(world, playerIndex);
  if (!boat) return text;
  const details = [];
  if (boat.refuelActive) details.push(`Заправка ${Math.round(boat.refuelProgress)} процентов.`);
  if (boat.engineServiceActive) details.push(`Обслуживание мотора ${Math.round(boat.engineServiceProgress)} процентов.`);
  const brake = Math.max(0, boat.floatingBrakeReadyAt - world.time);
  details.push(brake > 0 ? `Плавучий тормоз будет готов через ${Math.ceil(brake)} секунд.` : "Плавучий тормоз готов.");
  return `${text} ${details.join(" ")}`;
}

export function snapshotWorld(world) {
  ensureWorld(world);
  return base.snapshotWorld(world);
}
