"use strict";

import {applyCombatAiModelV169} from "./free-roam-combat-ai-model-v169.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

const HIT_WINDOW_SECONDS = 1.05;
const HIT_THRESHOLD = 3;
const ESCAPE_MIN_SECONDS = 4.2;
const ESCAPE_MAX_SECONDS = 8.5;
const ESCAPE_EXTEND_SECONDS = 2.6;
const ESCAPE_DISTANCE = 255;
const REGROUP_SECONDS = 2.4;
const ESCAPE_SPEED = 18.5;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiV170 ||= {
    frame: null,
    automaticHits: [],
    phase: null,
    destination: null,
    sourcePlayer: null,
    minimumUntil: -999,
    maximumUntil: -999,
    escapeDistance: 225,
    regroupUntil: -999,
    retreatSerial: 0,
    newAutomaticHits: 0,
  };
  const state = world.freeCombatAiV170;
  if (!Array.isArray(state.automaticHits)) state.automaticHits = [];
  if (!Number.isFinite(state.minimumUntil)) state.minimumUntil = -999;
  if (!Number.isFinite(state.maximumUntil)) state.maximumUntil = -999;
  if (!Number.isFinite(state.escapeDistance)) state.escapeDistance = 225;
  if (!Number.isFinite(state.regroupUntil)) state.regroupUntil = -999;
  if (!Number.isFinite(state.retreatSerial)) state.retreatSerial = 0;
  return state;
}

function pointForPlayer(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return world.boats?.find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function livingPoints(world) {
  return (world.players || [])
    .map((player, index) => ({player, index, point: pointForPlayer(world, index)}))
    .filter(({player, index, point}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && point);
}

function positionSnapshot(boat) {
  if (!boat) return null;
  return {
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
    heading: Number(boat.heading) || 0,
    speed: Number(boat.speed) || 0,
  };
}

function automaticHeavyHit(event) {
  return event?.type === "heavy-component-hit"
    && String(event.weapon || "").toLowerCase() === "automatic";
}

function trimHits(state, now) {
  state.automaticHits = state.automaticHits.filter(hit => now - hit.at <= HIT_WINDOW_SECONDS);
}

export function recordAutomaticPressureV170(world, state, eventStart = 0) {
  const now = Number(world.time) || 0;
  trimHits(state, now);
  let added = 0;
  for (const event of (world.events || []).slice(Math.max(0, Number(eventStart) || 0))) {
    if (!automaticHeavyHit(event)) continue;
    const sourcePlayer = Number(event.sourcePlayer);
    state.automaticHits.push({
      at: Number.isFinite(Number(event.at)) ? Number(event.at) : now,
      sourcePlayer: Number.isInteger(sourcePlayer) ? sourcePlayer : null,
    });
    added += 1;
  }
  trimHits(state, now);
  state.newAutomaticHits = added;
  return state.automaticHits.length;
}

function pressureSource(state) {
  const counts = new Map();
  for (const hit of state.automaticHits) {
    if (!Number.isInteger(hit.sourcePlayer)) continue;
    counts.set(hit.sourcePlayer, (counts.get(hit.sourcePlayer) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function retreatCandidates() {
  const points = [];
  for (const x of [16, 42, 88, 150, 210, 272, 334, 380, 404]) {
    for (const y of [86, 108, 150, 200, 250, 292, 308]) points.push({x, y});
  }
  return points;
}

function achievableEscapeDistance(world, sourcePlayer) {
  const source = pointForPlayer(world, sourcePlayer);
  if (!source) return 225;
  const farthest = Math.max(...retreatCandidates().map(point => distance(point, source)));
  return clamp(farthest - 10, 205, ESCAPE_DISTANCE);
}

function safestDestination(world, boat, sourcePlayer, serial) {
  const source = pointForPlayer(world, sourcePlayer);
  const living = livingPoints(world);
  return retreatCandidates()
    .map(point => {
      const sourceDistance = source ? distance(point, source) : 0;
      const nearest = living.length ? Math.min(...living.map(item => distance(point, item.point))) : sourceDistance;
      const travel = distance(point, boat);
      const variation = ((point.x * 19 + point.y * 23 + serial * 29) % 17) * 0.01;
      return {point, travel, score: sourceDistance * 5 + nearest * 1.5 + Math.min(140, travel) + variation};
    })
    .filter(item => item.travel >= 24)
    .sort((left, right) => right.score - left.score)[0]?.point
    || {x: clamp(boat.x, 16, 404), y: clamp(boat.y, 86, 308)};
}

function removeWeakerDisengageMessage(world, eventStart) {
  const start = Math.max(0, Number(eventStart) || 0);
  const prefix = (world.events || []).slice(0, start);
  const filtered = (world.events || []).slice(start).filter(event => !(
    event?.type === "heavy-tactical-mode-v168"
    && event.mode === "disengage"
  ));
  world.events = [...prefix, ...filtered];
}

function canSuppressionEscape(world) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  return Boolean(
    heavy
    && boat
    && boat.active
    && !boat.destroyed
    && Number(boat.hull) > 0
    && heavy.phase === "combat"
    && Number(boat.engineHealth) > 0
  );
}

function startEscape(world, state, eventStart, repeat = false) {
  if (!canSuppressionEscape(world)) return false;
  const boat = world.freeHeavyPursuer.boat;
  const now = Number(world.time) || 0;
  state.phase = "escape";
  const detectedSource = pressureSource(state);
  if (Number.isInteger(detectedSource)) state.sourcePlayer = detectedSource;
  state.minimumUntil = Math.max(Number(state.minimumUntil) || -999, now + (repeat ? ESCAPE_EXTEND_SECONDS : ESCAPE_MIN_SECONDS));
  state.maximumUntil = Math.max(Number(state.maximumUntil) || -999, now + (repeat ? ESCAPE_EXTEND_SECONDS + 1.5 : ESCAPE_MAX_SECONDS));
  state.escapeDistance = achievableEscapeDistance(world, state.sourcePlayer);
  state.retreatSerial += 1;
  state.destination = safestDestination(world, boat, state.sourcePlayer, state.retreatSerial);
  boat.speed = Math.max(Number(boat.speed) || 0, 11.5);
  if (!repeat) {
    removeWeakerDisengageMessage(world, eventStart);
    emit(world, "heavy-automatic-suppression-escape-v170",
      "Плотная очередь из автомата прижала тяжёлый катер. Он мгновенно даёт полный ход и уходит. Придётся догонять или ждать нового захода.",
      [0, 1], {
        sourcePlayer: state.sourcePlayer,
        x: boat.x,
        y: boat.y,
      });
  }
  return true;
}

function moveTo(boat, destination, speed, dt, turnRate = 76) {
  const desired = bearing(boat, destination);
  const error = wrapDeg(desired - (Number(boat.heading) || 0));
  boat.heading = wrapDeg((Number(boat.heading) || 0) + clamp(error, -turnRate * dt, turnRate * dt));
  const desiredSpeed = Math.abs(error) > 130 ? speed * 0.72 : speed;
  boat.speed += clamp(desiredSpeed - (Number(boat.speed) || 0), -14 * dt, 18 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp((Number(boat.x) || 0) + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp((Number(boat.y) || 0) - Math.cos(angle) * boat.speed * dt, 84, 310);
}

function cancelRetreat(state) {
  state.phase = null;
  state.destination = null;
  state.sourcePlayer = null;
  state.minimumUntil = -999;
  state.maximumUntil = -999;
  state.escapeDistance = 225;
  state.regroupUntil = -999;
  state.automaticHits = [];
  state.newAutomaticHits = 0;
}

export function applyAutomaticSuppressionRetreatV170(world, state, dt, frame = null) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  if (!boat || !heavy || !boat.active || boat.destroyed || Number(boat.hull) <= 0) {
    cancelRetreat(state);
    return false;
  }

  const pressure = state.automaticHits.length;
  const newHits = Math.max(0, Number(state.newAutomaticHits) || 0);
  if (pressure >= HIT_THRESHOLD && newHits > 0 && state.phase === "escape") {
    startEscape(world, state, frame?.eventStart, true);
  } else if (pressure >= HIT_THRESHOLD && newHits > 0 && !state.phase) {
    startEscape(world, state, frame?.eventStart, false);
  }

  if (!state.phase) return false;
  if (!canSuppressionEscape(world)) {
    cancelRetreat(state);
    return false;
  }

  if (frame?.position) Object.assign(boat, frame.position);
  if (state.phase === "escape") boat.speed = Math.max(Number(boat.speed) || 0, 11.5);
  const now = Number(world.time) || 0;
  const source = pointForPlayer(world, state.sourcePlayer);
  const sourceDistance = source ? distance(boat, source) : Infinity;

  if (state.phase === "escape") {
    const destinationUnsafe = !state.destination
      || distance(boat, state.destination) <= 9
      || (source && distance(state.destination, source) < state.escapeDistance);
    if (destinationUnsafe) {
      state.retreatSerial += 1;
      state.destination = safestDestination(world, boat, state.sourcePlayer, state.retreatSerial);
    }
    moveTo(boat, state.destination, ESCAPE_SPEED, dt, 82);
    boat.targetPlayer = Number.isInteger(state.sourcePlayer) ? state.sourcePlayer : boat.targetPlayer;
    const escapedFarEnough = sourceDistance >= state.escapeDistance;
    const escapeTimedOut = now >= state.maximumUntil;
    if (now >= state.minimumUntil && pressure < HIT_THRESHOLD && (escapedFarEnough || escapeTimedOut)) {
      state.phase = "regroup";
      state.regroupUntil = now + REGROUP_SECONDS;
      emit(world, "heavy-automatic-suppression-regroup-v170",
        "Тяжёлый катер оторвался от обстрела и перестраивается для нового дальнего захода.",
        [0, 1], {x: boat.x, y: boat.y, sourcePlayer: state.sourcePlayer});
    }
    return true;
  }

  if (state.phase === "regroup") {
    if ((pressure >= HIT_THRESHOLD && newHits > 0) || sourceDistance < 205) {
      return startEscape(world, state, frame?.eventStart, true);
    }
    moveTo(boat, state.destination || boat, 7.5, dt, 48);
    if (now >= state.regroupUntil) {
      cancelRetreat(state);
      emit(world, "heavy-automatic-suppression-return-v170",
        "Тяжёлый катер закончил манёвр и снова выходит на дальнюю боевую дистанцию.",
        [0, 1], {x: boat.x, y: boat.y});
    }
    return true;
  }

  return false;
}

export function prepareCombatAiV170Overlay(world, helpers = {}) {
  const state = ensureState(world);
  state.frame = {
    eventStart: world.events?.length || 0,
    position: positionSnapshot(world.freeHeavyPursuer?.boat),
  };
  applyCombatAiModelV169(world, 0, helpers);
  return state;
}

export function finishCombatAiV170Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  applyCombatAiModelV169(world, Math.max(0, Number(dt) || 0), helpers);
  recordAutomaticPressureV170(world, state, state.frame?.eventStart);
  applyAutomaticSuppressionRetreatV170(world, state, Math.max(0, Number(dt) || 0), state.frame);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV170(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV170Overlay(world, helpers);
  return finishCombatAiV170Overlay(world, dt, helpers);
}
