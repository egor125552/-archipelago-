"use strict";

import * as base from "./game-core-v10.js?base=5";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  courseHoldAcquireAngle: 10,
  courseHoldCorrectionRate: 48,
  survivorApproachRange: 22,
  survivorApproachSpeed: 3.4,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  const centered = Math.abs(relative) <= CONFIG.navigationCenterTolerance;
  const pan = centered
    ? 0
    : clamp((relative - Math.sign(relative) * CONFIG.navigationCenterTolerance) / (82 - CONFIG.navigationCenterTolerance), -1, 1);
  return {distance: distance(state.boat, target), absolute, relative, centered, pan};
}

function directionText(relative) {
  const amount = Math.abs(relative);
  if (amount <= CONFIG.navigationCenterTolerance) return "прямо";
  const side = relative < 0 ? "слева" : "справа";
  return amount <= 32 ? `чуть ${side}` : side;
}

function ensureV11State(state) {
  if (!state || typeof state !== "object") return state;
  state.navigation ||= {};
  if (typeof state.navigation.courseHold !== "boolean") state.navigation.courseHold = false;
  if (!Number.isFinite(state.navigation.courseHoldTargetHeading)) state.navigation.courseHoldTargetHeading = Number(state.boat?.heading) || 0;
  if (!Number.isFinite(state.navigation.courseHoldAnnouncedAt)) state.navigation.courseHoldAnnouncedAt = -999;
  if (typeof state.navigation.approachAssist !== "boolean") state.navigation.approachAssist = false;
  return state;
}

function forceDirectTarget(state) {
  const targetId = state.navigation.lockedTargetId;
  if (!targetId) return;
  state.navigation.routeTargetId = targetId;
  state.navigation.routeStage = 999;
  state.navigation.beaconResumeAt = 0;
}

function turnToward(current, target, maximum) {
  const change = clamp(wrapDeg(target - current), -maximum, maximum);
  return wrapDeg(current + change);
}

function applyCourseHold(state, dt, events) {
  const objective = objectiveFor(state);
  if (!objective || !state.navigation.assistEnabled || state.damageControl?.floodEmergency || state.controls.rescue) {
    state.navigation.courseHold = false;
    return;
  }

  const steering = Boolean(state.controls.left || state.controls.right);
  const bearing = bearingTo(state, objective);
  if (steering) {
    state.navigation.courseHold = false;
    return;
  }

  // Releasing the wheel must stop residual rudder drift immediately.
  state.boat.rudder = 0;
  const movingOrStarting = state.controls.forward || state.boat.speed > CONFIG.motionStopSpeed;
  if (!state.navigation.courseHold && movingOrStarting && Math.abs(bearing.relative) <= CONFIG.courseHoldAcquireAngle) {
    state.navigation.courseHold = true;
    state.navigation.courseHoldTargetHeading = bearing.absolute;
    if (clock(state) - state.navigation.courseHoldAnnouncedAt > 1) {
      state.navigation.courseHoldAnnouncedAt = clock(state);
      state.message = `Прямой курс на цель захвачен. Руль можно отпустить: лодка сама удержит ${objectiveLabel(objective)} по центру.`;
      events.push({type: "course-hold", targetId: objective.id});
    }
  }
  if (!state.navigation.courseHold) return;

  state.navigation.courseHoldTargetHeading = bearing.absolute;
  state.boat.heading = turnToward(
    state.boat.heading,
    state.navigation.courseHoldTargetHeading,
    CONFIG.courseHoldCorrectionRate * dt,
  );
}

function applyFriendlyApproach(state, dt, events) {
  const objective = objectiveFor(state);
  if (!objective || objective.kind !== "человек" || state.controls.rescue) {
    state.navigation.approachAssist = false;
    return;
  }
  const metres = distance(state.boat, objective);
  if (metres > CONFIG.survivorApproachRange) {
    state.navigation.approachAssist = false;
    return;
  }

  state.controls.forward = false;
  state.boat.throttle = 0;
  const previous = Math.abs(state.boat.speed);
  if (previous > CONFIG.survivorApproachSpeed) {
    state.boat.speed = Math.sign(state.boat.speed || 1) * Math.max(
      CONFIG.survivorApproachSpeed,
      previous * Math.exp(-3.4 * dt),
    );
  }
  if (metres <= CONFIG.rescueRadius) state.boat.speed = 0;

  if (!state.navigation.approachAssist) {
    state.navigation.approachAssist = true;
    state.message = `Финальный подход к ${objectiveLabel(objective)}. Газ снят автоматически; держи маяк по центру до зоны троса.`;
    events.push({type: "approach-assist", targetId: objective.id});
  }
}

export function createGame(options = {}) {
  return ensureV11State(base.createGame(options));
}

export function startGame(state) {
  ensureV11State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message = "Локация открыта для прямой навигации. Нажми сонар, повернись к двойному центральному сигналу и дай газ. После захвата курса руль можно отпустить.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV11State(state);
  if (active && (control === "left" || control === "right")) state.navigation.courseHold = false;
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV11State(state);
  const result = base.command(state, action, actor);
  if (action === "sonar" && result.ok) {
    forceDirectTarget(state);
    state.navigation.courseHold = false;
    state.navigation.approachAssist = false;
    const objective = objectiveFor(state);
    if (!objective) return result;
    const bearing = bearingTo(state, objective);
    state.sonar.lastResult = {
      ...(state.sonar.lastResult || {}),
      id: objective.id,
      objectiveDistance: bearing.distance,
      distance: bearing.distance,
      relativeAngle: bearing.relative,
      pan: bearing.pan,
      routeIsWaypoint: false,
    };
    state.message = `Сонар закрепил цель: ${objectiveLabel(objective)} ${directionText(bearing.relative)}, ${Math.round(bearing.distance)} метров. Это прямой свободный курс. Совмести маяк с центром, дай газ и отпусти руль после сообщения о захвате курса.`;
    result.events = (result.events || []).map(event => ["sonar", "sonar-lock"].includes(event.type)
      ? {...event, pan: bearing.pan, distance: bearing.distance, relativeAngle: bearing.relative, routeIsWaypoint: false}
      : event);
  } else if (action === "where" && result.ok) {
    const objective = objectiveFor(state);
    if (objective) {
      const bearing = bearingTo(state, objective);
      state.message += ` Прямой маяк на ${objectiveLabel(objective)}: ${directionText(bearing.relative)}, ${Math.round(bearing.distance)} метров. Удержание курса ${state.navigation.courseHold ? "включено" : "ещё не захвачено"}.`;
    }
  }
  return result;
}

export function step(state, dt) {
  ensureV11State(state);
  forceDirectTarget(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const events = [];
  applyCourseHold(state, safeDt, events);
  applyFriendlyApproach(state, safeDt, events);
  events.push(...(base.step(state, safeDt) || []));
  if (events.some(event => event.type === "rescue-complete" || event.type === "win" || event.type === "lose")) {
    state.navigation.courseHold = false;
    state.navigation.approachAssist = false;
  }
  return events;
}

export function getView(state) {
  ensureV11State(state);
  forceDirectTarget(state);
  const view = base.getView(state);
  const objective = objectiveFor(state);
  const bearing = objective ? bearingTo(state, objective) : null;
  const rescueMode = Boolean(objective?.kind === "человек"
    && (state.controls.rescue
      || (bearing.distance <= CONFIG.rescueRadius && Math.abs(state.boat.speed) <= CONFIG.rescueSpeedLimit)));
  const centered = Boolean(state.navigation.courseHold || bearing?.centered);

  return {
    ...view,
    navigation: {
      ...view.navigation,
      directMode: true,
      courseHold: state.navigation.courseHold,
      approachAssist: state.navigation.approachAssist,
      targetLabel: objective ? objectiveLabel(objective) : null,
      targetDistance: bearing?.distance ?? null,
      targetRelativeAngle: bearing?.relative ?? null,
      guideDistance: bearing?.distance ?? null,
      guidePan: rescueMode || centered ? 0 : (bearing?.pan ?? 0),
      guideCentered: rescueMode || centered,
      guideIsWaypoint: false,
      beaconPan: rescueMode || centered ? 0 : (bearing?.pan ?? 0),
      beaconCentered: rescueMode || centered,
      beaconSuppressed: rescueMode,
      rescueMode,
      routeAnnouncement: false,
      routeStage: 0,
      routeWaypointId: objective?.id || null,
      routeWaypointLabel: objective ? objectiveLabel(objective) : null,
    },
  };
}

export function getRoutePlan(state, targetId) {
  ensureV11State(state);
  const objective = objectiveFor(state, targetId);
  return objective ? [{...objective}] : [];
}

export function serialize(state) {
  return base.serialize(ensureV11State(state));
}

export function deserialize(value) {
  return ensureV11State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
