"use strict";

import * as base from "./game-core.js?base=5";

export const CONFIG = Object.freeze({...base.CONFIG, turnRate: 1.18});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function ensureV4State(state) {
  if (!state || typeof state !== "object") return state;
  if (typeof state.timed !== "boolean") state.timed = false;
  if (!Number.isFinite(state.totalElapsed)) state.totalElapsed = Number(state.elapsed) || 0;
  state.navigation ||= {lastSteer: 0};
  state.feedback ||= {};
  if (!Number.isFinite(state.feedback.proximityAt)) state.feedback.proximityAt = -999;
  return state;
}

function shiftInternalClock(state, amount) {
  state.elapsed = Math.max(0, state.elapsed - amount);
  for (const key of Object.keys(state.collisions || {})) state.collisions[key] -= amount;
  for (const key of Object.keys(state.feedback || {})) {
    if (Number.isFinite(state.feedback[key])) state.feedback[key] -= amount;
  }
  for (const item of state.eventLog || []) {
    if (Number.isFinite(item.time)) item.time = Math.max(0, item.time - amount);
  }
}

function describeRelative(boat, target, kind) {
  const metres = distance(boat, target);
  const absolute = deg(Math.atan2(target.x - boat.x, target.y - boat.y));
  const relative = wrapDeg(absolute - boat.heading);
  const side = Math.abs(relative) < 10 ? "прямо" : relative < 0 ? "слева" : "справа";
  return {target, kind, distance: metres, relative, side, pan: clamp(relative / 75, -1, 1)};
}

function enhancedSonar(state) {
  if (state.sonar.cooldown > 0) {
    state.message = `Сонар перезаряжается: ${state.sonar.cooldown.toFixed(1)} секунды.`;
    return {ok: false, reason: "cooldown", events: [{type: "ui-deny"}]};
  }

  const objectives = [
    ...state.world.survivors.filter(item => !item.rescued).map(item => describeRelative(state.boat, item, "человек")),
    ...(state.rescued >= 2 ? [describeRelative(state.boat, state.world.harbor, "гавань")] : []),
  ].sort((a, b) => a.distance - b.distance);
  const objective = objectives[0] || describeRelative(state.boat, state.world.harbor, "гавань");
  const hazards = state.world.hazards
    .map(item => describeRelative(state.boat, item, item.type === "reef" ? "риф" : "обломки"))
    .filter(item => item.distance <= CONFIG.sonarRange)
    .sort((a, b) => a.distance - b.distance);
  const hazard = hazards[0] || null;

  state.sonar.cooldown = CONFIG.sonarCooldown;
  state.sonar.pings += 1;
  state.sonar.lastResult = {
    kind: objective.kind,
    id: objective.target.id || "harbor",
    distance: objective.distance,
    relativeAngle: objective.relative,
    pan: objective.pan,
  };

  const danger = hazard
    ? ` Ближайшая опасность: ${hazard.kind} ${hazard.side}, ${Math.round(hazard.distance)} метров.`
    : " В ближнем секторе опасностей нет.";
  state.message = `Сонар. Цель: ${objective.kind} ${objective.side}, ${Math.round(objective.distance)} метров.${danger}`;
  const events = [{type: "sonar", pan: objective.pan, distance: objective.distance, kind: objective.kind}];
  if (hazard) events.push({type: "hazard-ping", pan: hazard.pan, distance: hazard.distance, kind: hazard.kind});
  return {ok: true, events};
}

export function createGame(options = {}) {
  const state = ensureV4State(base.createGame(options));
  state.timed = options.timed === true || globalThis.__echoNextTimed === true;
  return state;
}

export function startGame(state) {
  ensureV4State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message += state.timed
      ? " Штормовой проход: на операцию даётся четыре минуты."
      : " Свободный режим: ограничения времени нет.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV4State(state);
  if (action === "sonar" && state.phase === "playing") {
    if (state.mode === "coop" && actor !== "crew") return base.command(state, action, actor);
    return enhancedSonar(state);
  }
  return base.command(state, action, actor);
}

export function step(state, dt) {
  ensureV4State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);

  // The legacy engine uses elapsed time for both cooldowns and its timed ending.
  // In free mode shift every related timestamp together before the old limit is reached.
  if (!state.timed && state.elapsed > 210) shiftInternalClock(state, 120);

  const steer = Number(state.controls.right) - Number(state.controls.left);
  const previousSteer = state.navigation.lastSteer || 0;
  const events = base.step(state, safeDt) || [];
  state.totalElapsed += safeDt;

  if (state.phase === "playing" && steer !== 0) {
    const direction = Math.sign(state.boat.speed || 1);
    const speedFactor = clamp(Math.abs(state.boat.speed) / 4.5, 0.45, 1.35);
    // Extra accessible steering authority, especially at low speed.
    state.boat.heading = wrapDeg(state.boat.heading + steer * 0.31 * speedFactor * safeDt * 60 * direction);
  }

  if (steer !== previousSteer) {
    if (steer !== 0) events.push({type: "turn", direction: steer < 0 ? "left" : "right", pan: steer < 0 ? -0.88 : 0.88});
    else if (previousSteer !== 0) events.push({type: "turn-complete", heading: state.boat.heading, pan: previousSteer < 0 ? -0.5 : 0.5});
    state.navigation.lastSteer = steer;
  }

  if (state.phase === "playing") {
    const nearby = state.world.hazards
      .map(hazard => describeRelative(state.boat, hazard, hazard.type === "reef" ? "риф" : "обломки"))
      .filter(item => item.distance < 30 && Math.abs(item.relative) < 75)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearby && state.totalElapsed - state.feedback.proximityAt > 4) {
      state.feedback.proximityAt = state.totalElapsed;
      events.push({type: "proximity", pan: nearby.pan, distance: nearby.distance, kind: nearby.kind});
    }
  }

  return events;
}

export function getView(state) {
  ensureV4State(state);
  const view = base.getView(state);
  return {
    ...view,
    elapsed: state.totalElapsed,
    timed: state.timed,
    remaining: state.timed ? Math.max(0, CONFIG.missionDuration - state.elapsed) : null,
  };
}

export function serialize(state) {
  return base.serialize(ensureV4State(state));
}

export function deserialize(value) {
  return ensureV4State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
