"use strict";

import * as base from "./game-core-v11.js?base=1";
import {collisionSeverity} from "./collision-model.js";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  coastBrakeSeconds: 5,
  miniArmor: 30,
  pumpUpgradeRate: 2.8,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const OPERATIONS = Object.freeze({
  1: Object.freeze({name: "Тихая бухта", rewardBase: 500}),
  2: Object.freeze({name: "Проход среди обломков", rewardBase: 650}),
  3: Object.freeze({name: "Северный фарватер", rewardBase: 800}),
});

const BOATS = Object.freeze({
  strizh: Object.freeze({
    id: "strizh",
    name: "Катер «Стриж»",
    maxSpeedMultiplier: 1,
    accelerationMultiplier: 1,
    turnRateMultiplier: 1,
    engineHeatMultiplier: 1,
    collisionDamageMultiplier: 1,
    collisionLeakMultiplier: 1,
  }),
  kasatka: Object.freeze({
    id: "kasatka",
    name: "Катер «Касатка»",
    maxSpeedMultiplier: 0.96,
    accelerationMultiplier: 0.9,
    turnRateMultiplier: 0.88,
    engineHeatMultiplier: 0.76,
    collisionDamageMultiplier: 0.72,
    collisionLeakMultiplier: 0.7,
  }),
});

function safeLoadout(options = {}) {
  const source = options.progression && typeof options.progression === "object" ? options.progression : {};
  const level = clamp(Math.trunc(Number(source.level) || 1), 1, 3);
  // The profile layer owns unlock validation. Once unlocked, Kasatka may also
  // be taken back into earlier operations for replay and record attempts.
  const requestedBoat = source.boatId === "kasatka" ? "kasatka" : "strizh";
  return {
    level,
    boatId: requestedBoat,
    upgrades: {
      coastBrake: source.upgrades?.["coast-brake"] === true,
      miniArmor: source.upgrades?.["mini-armor"] === true,
      highFlowPump: source.upgrades?.["high-flow-pump"] === true,
    },
  };
}

function configureWorld(state) {
  const level = state.progression.level;
  if (level >= 2) {
    const firstGate = [
      {id: "wreck-gate", x: 4, y: 34, radius: 5.5, damage: 17, label: "обломки баржи слева от фарватера"},
      {id: "east-reef", x: 40, y: 36, radius: 5.5, damage: 18, label: "обломки причала справа от фарватера", type: "wreck"},
    ];
    for (const change of firstGate) Object.assign(state.world.hazards.find(item => item.id === change.id), change);
  }
  if (level >= 3) {
    const northGate = [
      {id: "middle-ridge", x: -40, y: 70, radius: 5.5, damage: 20, label: "каменная гряда слева от северного прохода"},
      {id: "north-wreck", x: 30, y: 70, radius: 5.5, damage: 19, label: "затонувший катер справа от северного прохода"},
    ];
    for (const change of northGate) Object.assign(state.world.hazards.find(item => item.id === change.id), change);
  }
  state.world.name = `${state.world.name}: ${OPERATIONS[level].name}`;
}

function applyBoat(state) {
  const spec = BOATS[state.progression.boatId] || BOATS.strizh;
  Object.assign(state.boat, {
    modelId: spec.id,
    modelName: spec.name,
    maxSpeedMultiplier: spec.maxSpeedMultiplier,
    accelerationMultiplier: spec.accelerationMultiplier,
    turnRateMultiplier: spec.turnRateMultiplier,
    engineHeatMultiplier: spec.engineHeatMultiplier,
    collisionDamageMultiplier: spec.collisionDamageMultiplier,
    collisionLeakMultiplier: spec.collisionLeakMultiplier,
    armor: state.progression.upgrades.miniArmor ? CONFIG.miniArmor : 0,
    armorMax: state.progression.upgrades.miniArmor ? CONFIG.miniArmor : 0,
  });
}

function ensureV12State(state, options = {}) {
  if (!state || typeof state !== "object") return state;
  if (!state.progression || typeof state.progression !== "object" || !Number.isFinite(state.progression.level)) {
    const loadout = safeLoadout(options);
    state.progression = {
      ...loadout,
      operationName: OPERATIONS[loadout.level].name,
      coastBrakeActive: false,
      coastBrakeElapsed: 0,
      coastBrakeInitialSpeed: 0,
      coastBrakeAnnounced: false,
      rewardCredits: 0,
      rewardFinalized: false,
      collisionCount: 0,
    };
    configureWorld(state);
    applyBoat(state);
  }
  state.progression.upgrades ||= {coastBrake: false, miniArmor: false, highFlowPump: false};
  if (!Number.isFinite(state.progression.coastBrakeElapsed)) state.progression.coastBrakeElapsed = 0;
  if (!Number.isFinite(state.progression.coastBrakeInitialSpeed)) state.progression.coastBrakeInitialSpeed = 0;
  if (!Number.isFinite(state.progression.collisionCount)) state.progression.collisionCount = 0;
  if (!Number.isFinite(state.boat.armor)) state.boat.armor = 0;
  if (!Number.isFinite(state.boat.armorMax)) state.boat.armorMax = state.boat.armor;
  return state;
}

function beginCoastBrake(state) {
  if (!state.progression.upgrades.coastBrake || Math.abs(state.boat.speed) < 0.08) return;
  state.progression.coastBrakeActive = true;
  state.progression.coastBrakeElapsed = 0;
  state.progression.coastBrakeInitialSpeed = Math.abs(state.boat.speed);
  state.progression.coastBrakeDirection = Math.sign(state.boat.speed || 1);
  state.progression.coastBrakeAnnounced = false;
}

function applyCoastBrake(state, dt, events) {
  const progress = state.progression;
  if (!progress.upgrades.coastBrake) return;
  if (state.controls.forward || state.controls.reverse || state.damageControl?.floodEmergency) {
    progress.coastBrakeActive = false;
    progress.coastBrakeElapsed = 0;
    return;
  }
  if (!progress.coastBrakeActive && Math.abs(state.boat.speed) >= 0.08) beginCoastBrake(state);
  if (!progress.coastBrakeActive) return;
  if (events.some(event => event.type === "collision") || state.navigation?.approachAssist || state.controls.rescue) {
    progress.coastBrakeActive = false;
    progress.coastBrakeElapsed = 0;
    return;
  }

  progress.coastBrakeElapsed += dt;
  const remaining = clamp(1 - progress.coastBrakeElapsed / CONFIG.coastBrakeSeconds, 0, 1);
  const limit = progress.coastBrakeInitialSpeed * remaining;
  if (remaining > 0) state.boat.speed = progress.coastBrakeDirection * limit;
  if (remaining > 0) return;

  state.boat.speed = 0;
  state.boat.throttle = 0;
  progress.coastBrakeActive = false;
  if (!progress.coastBrakeAnnounced) {
    progress.coastBrakeAnnounced = true;
    state.message = "Береговой автотормоз погасил инерцию. Лодка полностью остановлена.";
    events.push({type: "auto-stop"});
  }
}

function applyPumpUpgrade(state, dt) {
  if (!state.progression.upgrades.highFlowPump || !state.boat.pumpActive) return;
  state.boat.water = clamp(state.boat.water - CONFIG.pumpUpgradeRate * dt, 0, 100);
}

function finalizeReward(state, events) {
  if (!state.won || state.progression.rewardFinalized) return;
  const level = state.progression.level;
  const hullBonus = Math.round(Math.max(0, state.boat.hull) * 2.5);
  const stormBonus = state.timed ? 300 : 0;
  const collisionPenalty = Math.min(240, state.progression.collisionCount * 60);
  const reward = Math.max(250, OPERATIONS[level].rewardBase + hullBonus + stormBonus - collisionPenalty);
  state.progression.rewardCredits = reward;
  state.progression.rewardFinalized = true;
  const unlock = level === 1
    ? " Открыт уровень 2 и магазин спасслужбы."
    : level === 2
      ? " Открыт уровень 3 и катер «Касатка»."
      : " Все три операции открыты.";
  state.message += ` Награда: ${reward} жетонов спасслужбы.${unlock}`;
  events.push({type: "operation-reward", reward, level, unlockedLevel: Math.min(3, level + 1)});
}

export function createGame(options = {}) {
  return ensureV12State(base.createGame(options), options);
}

export function startGame(state) {
  ensureV12State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    const gateText = state.progression.level === 1
      ? "Прямые маршруты полностью открыты."
      : state.progression.level === 2
        ? "На первом пути есть озвучиваемый проход между обломками; центральная линия свободна."
        : "На маршруте два озвучиваемых прохода между обломками; центральные линии свободны.";
    state.message = `Уровень ${state.progression.level}: ${state.progression.operationName}. ${state.boat.modelName}. ${gateText} Нажми сонар и совмести маяк с центром.`;
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV12State(state);
  const wasForward = Boolean(state.controls.forward);
  const result = base.setControl(state, control, active, actor);
  if (result && control === "forward") {
    if (active) {
      state.progression.coastBrakeActive = false;
      state.progression.coastBrakeElapsed = 0;
    } else if (wasForward) beginCoastBrake(state);
  }
  if (result && control === "reverse" && active) state.progression.coastBrakeActive = false;
  return result;
}

export function command(state, action, actor = "captain") {
  ensureV12State(state);
  return base.command(state, action, actor);
}

export function step(state, dt) {
  ensureV12State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const events = base.step(state, safeDt) || [];
  const collisions = events.filter(event => event.type === "collision");
  state.progression.collisionCount += collisions.length;
  applyPumpUpgrade(state, safeDt);
  applyCoastBrake(state, safeDt, events);
  finalizeReward(state, events);
  return events;
}

export function getView(state) {
  ensureV12State(state);
  const view = base.getView(state);
  return {
    ...view,
    boat: {
      ...view.boat,
      modelId: state.boat.modelId,
      modelName: state.boat.modelName,
      armor: state.boat.armor,
      armorMax: state.boat.armorMax,
    },
    progression: {
      level: state.progression.level,
      operationName: state.progression.operationName,
      boatId: state.progression.boatId,
      upgrades: {...state.progression.upgrades},
      coastBrakeActive: state.progression.coastBrakeActive,
      coastBrakeRemaining: state.progression.coastBrakeActive
        ? Math.max(0, CONFIG.coastBrakeSeconds - state.progression.coastBrakeElapsed)
        : null,
      collisionCount: state.progression.collisionCount,
      rewardCredits: state.progression.rewardCredits,
      rewardFinalized: state.progression.rewardFinalized,
    },
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV12State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV12State(state));
}

export function deserialize(value) {
  return ensureV12State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
export {collisionSeverity};
