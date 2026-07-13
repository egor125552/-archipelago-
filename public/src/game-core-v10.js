"use strict";

import * as base from "./game-core-v9-1.js?base=3";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  routeReachRadius: 6,
  dockingAssistRange: 28,
  dockingSpeedLimit: 4.2,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const ROUTES = Object.freeze({
  "survivor-a": Object.freeze([
    Object.freeze({id: "first-east-lane", label: "восточный коридор", x: 18, y: 22}),
  ]),
  "survivor-b": Object.freeze([
    Object.freeze({id: "middle-east-lane", label: "восточный коридор", x: 24, y: 78}),
    Object.freeze({id: "north-east-gate", label: "северный проход", x: 22, y: 112}),
  ]),
  harbor: Object.freeze([
    Object.freeze({id: "north-return-gate", label: "северный проход", x: 22, y: 112}),
    Object.freeze({id: "middle-return-lane", label: "восточный коридор", x: 24, y: 78}),
    Object.freeze({id: "south-return-lane", label: "южный коридор", x: 22, y: 40}),
    Object.freeze({id: "harbor-final", label: "прямой створ гавани", x: 12, y: 28}),
  ]),
});

function objectiveFor(state, id = state.navigation?.lockedTargetId) {
  if (id === "harbor" && state.rescued >= 2) return {...state.world.harbor, kind: "гавань"};
  const survivor = state.world.survivors.find(item => item.id === id && !item.rescued);
  if (survivor) return {...survivor, kind: "человек"};
  return null;
}

function objectiveLabel(target) {
  if (!target) return "цель";
  if (target.id === "survivor-a") return "первый человек";
  if (target.id === "survivor-b") return "второй человек";
  if (target.id === "harbor") return "Южная гавань";
  return target.label || "цель";
}

function routeFor(targetId) {
  return (ROUTES[targetId] || []).map(point => ({...point, kind: "контрольная точка", finalId: targetId}));
}

function ensureV10State(state) {
  if (!state || typeof state !== "object") return state;
  state.navigation ||= {};
  if (!("routeTargetId" in state.navigation)) state.navigation.routeTargetId = null;
  if (!Number.isInteger(state.navigation.routeStage) || state.navigation.routeStage < 0) state.navigation.routeStage = 0;
  if (typeof state.navigation.dockingAssistAnnounced !== "boolean") state.navigation.dockingAssistAnnounced = false;
  if (!Number.isFinite(state.navigation.beaconResumeAt)) state.navigation.beaconResumeAt = 0;
  return state;
}

function clock(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  const centered = Math.abs(relative) <= CONFIG.navigationCenterTolerance;
  const pan = centered
    ? 0
    : clamp((relative - Math.sign(relative) * CONFIG.navigationCenterTolerance) / (82 - CONFIG.navigationCenterTolerance), -1, 1);
  return {distance: distance(state.boat, target), relative, centered, pan};
}

function directionText(relative) {
  const amount = Math.abs(relative);
  if (amount <= CONFIG.navigationCenterTolerance) return "прямо";
  const side = relative < 0 ? "слева" : "справа";
  return amount <= 32 ? `чуть ${side}` : side;
}

function checkpointText(count) {
  if (count === 1) return "1 контрольная точка";
  if (count >= 2 && count <= 4) return `${count} контрольные точки`;
  return `${count} контрольных точек`;
}

function resetRoute(state, targetId) {
  state.navigation.routeTargetId = targetId;
  state.navigation.routeStage = 0;
  state.navigation.dockingAssistAnnounced = false;
  state.navigation.beaconResumeAt = clock(state) + 0.8;
  const route = routeFor(targetId);
  while (state.navigation.routeStage < route.length
    && distance(state.boat, route[state.navigation.routeStage]) <= CONFIG.routeReachRadius) {
    state.navigation.routeStage += 1;
  }
}

function currentGuide(state, objective = objectiveFor(state)) {
  if (!objective) return null;
  if (state.navigation.routeTargetId !== objective.id) resetRoute(state, objective.id);
  const route = routeFor(objective.id);
  return state.navigation.routeStage < route.length ? route[state.navigation.routeStage] : objective;
}

function advanceRoute(state, events) {
  const objective = objectiveFor(state);
  if (!objective || state.navigation.routeTargetId !== objective.id) return;
  const route = routeFor(objective.id);
  if (state.navigation.routeStage >= route.length) return;
  const waypoint = route[state.navigation.routeStage];
  if (distance(state.boat, waypoint) > CONFIG.routeReachRadius) return;

  state.navigation.routeStage += 1;
  state.navigation.beaconResumeAt = clock(state) + 1.6;
  const next = state.navigation.routeStage < route.length ? route[state.navigation.routeStage] : objective;
  const bearing = bearingTo(state, next);
  const nextName = next.id === objective.id ? objectiveLabel(objective) : next.label;
  state.message = `Контрольная точка «${waypoint.label}» пройдена. Маяк переключается только сейчас. Следующий курс: ${nextName} ${directionText(bearing.relative)}, ${Math.round(bearing.distance)} метров.`;
  events.push({
    type: "route-advance",
    stage: state.navigation.routeStage,
    pan: bearing.pan,
    relativeAngle: bearing.relative,
    label: nextName,
  });
}

function applyDockingAssist(state, events) {
  const active = state.rescued >= 2 && state.navigation.lockedTargetId === "harbor";
  if (!active) {
    state.navigation.dockingAssistAnnounced = false;
    return;
  }
  const metres = distance(state.boat, state.world.harbor);
  if (metres > CONFIG.dockingAssistRange || Math.abs(state.boat.speed) <= CONFIG.dockingSpeedLimit) return;

  state.controls.forward = false;
  state.boat.throttle = 0;
  state.boat.speed = Math.sign(state.boat.speed || 1) * CONFIG.dockingSpeedLimit;
  if (!state.navigation.dockingAssistAnnounced) {
    state.navigation.dockingAssistAnnounced = true;
    state.message = "Вход в гавань. Швартовочный помощник снизил скорость до безопасной. Держи центральный двойной сигнал до завершения операции.";
    events.push({type: "docking-assist"});
  }
}

export function createGame(options = {}) {
  return ensureV10State(base.createGame(options));
}

export function startGame(state) {
  ensureV10State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message = "Лодка стоит в Южной гавани. Нажми сонар: безопасный маршрут разбит на контрольные точки, и каждая смена направления будет заранее озвучена.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV10State(state);
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV10State(state);
  const result = base.command(state, action, actor);
  if (action === "where" && result.ok) {
    const objective = objectiveFor(state);
    const guide = objective ? currentGuide(state, objective) : null;
    if (guide && objective && guide.id !== objective.id) {
      const bearing = bearingTo(state, guide);
      state.message += ` Текущий безопасный ориентир маяка: ${guide.label} ${directionText(bearing.relative)}, ${Math.round(bearing.distance)} метров.`;
    }
    return result;
  }
  if (action !== "sonar" || !result.ok) return result;

  const targetId = state.navigation.lockedTargetId;
  const objective = objectiveFor(state, targetId);
  if (!objective) return result;
  resetRoute(state, objective.id);
  const guide = currentGuide(state, objective);
  const guideBearing = bearingTo(state, guide);
  const objectiveDistance = distance(state.boat, objective);
  const route = routeFor(objective.id);
  const remainingStages = Math.max(0, route.length - state.navigation.routeStage);
  const guideName = guide.id === objective.id ? objectiveLabel(objective) : guide.label;

  state.sonar.lastResult = {
    ...(state.sonar.lastResult || {}),
    id: objective.id,
    objectiveDistance,
    distance: guideBearing.distance,
    relativeAngle: guideBearing.relative,
    pan: guideBearing.pan,
    routeIsWaypoint: guide.id !== objective.id,
  };
  state.message = remainingStages > 0
    ? `Сонар закрепил цель: ${objectiveLabel(objective)}, ${Math.round(objectiveDistance)} метров. Безопасный маршрут: ${checkpointText(remainingStages)}. Сейчас ${guideName} ${directionText(guideBearing.relative)}, ${Math.round(guideBearing.distance)} метров. Перед каждым переключением направления будет голосовое сообщение.`
    : `Сонар закрепил цель: ${objectiveLabel(objective)} ${directionText(guideBearing.relative)}, ${Math.round(guideBearing.distance)} метров. Маяк ведёт прямо к цели.`;
  result.events = (result.events || []).map(event => ["sonar", "sonar-lock"].includes(event.type)
    ? {...event, pan: guideBearing.pan, distance: guideBearing.distance, relativeAngle: guideBearing.relative, routeIsWaypoint: guide.id !== objective.id}
    : event);
  return result;
}

export function step(state, dt) {
  ensureV10State(state);
  const events = [];
  applyDockingAssist(state, events);
  events.push(...(base.step(state, dt) || []));

  if (events.some(event => event.type === "rescue-complete")) {
    state.navigation.routeTargetId = null;
    state.navigation.routeStage = 0;
  } else if (!events.some(event => ["collision", "lose", "win", "flood-emergency-start"].includes(event.type))) {
    advanceRoute(state, events);
  }
  return events;
}

export function getView(state) {
  ensureV10State(state);
  const view = base.getView(state);
  const objective = objectiveFor(state);
  const guide = objective ? currentGuide(state, objective) : null;
  const guideBearing = guide ? bearingTo(state, guide) : null;
  const objectiveDistance = objective ? distance(state.boat, objective) : null;
  const rescueMode = Boolean(objective?.kind === "человек"
    && (state.controls.rescue
      || (objectiveDistance <= CONFIG.rescueRadius && Math.abs(state.boat.speed) <= CONFIG.rescueSpeedLimit)));
  const routeAnnouncement = clock(state) < state.navigation.beaconResumeAt;

  return {
    ...view,
    navigation: {
      ...view.navigation,
      targetLabel: objective ? objectiveLabel(objective) : null,
      targetDistance: objectiveDistance,
      targetRelativeAngle: guideBearing?.relative ?? null,
      guideDistance: guideBearing?.distance ?? null,
      guidePan: rescueMode ? 0 : (guideBearing?.pan ?? 0),
      guideCentered: rescueMode || Boolean(guideBearing?.centered),
      guideIsWaypoint: Boolean(guide && objective && guide.id !== objective.id),
      beaconPan: rescueMode ? 0 : (guideBearing?.pan ?? 0),
      beaconCentered: rescueMode || Boolean(guideBearing?.centered),
      beaconSuppressed: rescueMode || routeAnnouncement,
      rescueMode,
      routeAnnouncement,
      routeStage: state.navigation.routeStage,
      routeWaypointId: guide?.id || null,
      routeWaypointLabel: guide?.label || null,
    },
  };
}

export function getRoutePlan(state, targetId) {
  ensureV10State(state);
  const objective = objectiveFor(state, targetId);
  return objective ? [...routeFor(objective.id), {...objective}] : [];
}

export function serialize(state) {
  return base.serialize(ensureV10State(state));
}

export function deserialize(value) {
  return ensureV10State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
