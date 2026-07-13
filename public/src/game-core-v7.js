"use strict";

import * as base from "./game-core-v6.js?base=1";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  navigationCenterTolerance: 10,
  bayHalfWidth: 62,
  baySouth: -8,
  bayNorth: 155,
  hazardWarningRange: 30,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const PASSIVE_EVENTS = new Set(["navigation-cue", "turn", "turn-complete", "turn-progress", "proximity"]);

function createBayWorld() {
  return {
    version: 13,
    seed: 7,
    name: "Бухта Северный Приют",
    bounds: {minX: -CONFIG.bayHalfWidth, maxX: CONFIG.bayHalfWidth, minY: CONFIG.baySouth, maxY: CONFIG.bayNorth},
    hazards: [
      // Hazards remain explorable at the banks, while all three mission legs
      // have a broad unobstructed direct corridor.
      {id: "wreck-gate", type: "wreck", label: "обломки баржи у западного берега", x: -49, y: 38, radius: 7, damage: 14},
      {id: "east-reef", type: "reef", label: "восточный прибрежный риф", x: 50, y: 74, radius: 8, damage: 17},
      {id: "middle-ridge", type: "reef", label: "западная каменная гряда", x: -50, y: 101, radius: 7, damage: 18},
      {id: "north-wreck", type: "wreck", label: "затонувший катер у восточного берега", x: 49, y: 132, radius: 7, damage: 14},
    ],
    survivors: [
      {id: "survivor-a", label: "первый человек", x: 28, y: 50, rescued: false, progress: 0},
      {id: "survivor-b", label: "второй человек", x: -27, y: 132, rescued: false, progress: 0},
    ],
    harbor: {id: "harbor", label: "южная гавань", x: 0, y: 0, radius: 20},
    current: {x: 0, y: 0},
    storm: {intensity: 0, target: 0},
  };
}

function objectiveLabel(target) {
  return target?.label || (target?.id === "harbor" ? "южная гавань" : "человек");
}

function ensureBayWorld(state) {
  if (!state.world || state.world.version !== 13) {
    const previous = state.world;
    const world = createBayWorld();
    for (const survivor of world.survivors) {
      const old = previous?.survivors?.find(item => item.id === survivor.id);
      if (old) {
        survivor.rescued = Boolean(old.rescued);
        survivor.progress = Number(old.progress) || 0;
      }
    }
    state.world = world;
  }
  state.world.current = {x: 0, y: 0};
  state.world.storm = {intensity: 0, target: 0};
}

function zoneAt(boat) {
  if (boat.y < 22) return {id: "harbor-basin", label: "Южная гавань"};
  if (boat.x > 12 && boat.y < 76) return {id: "east-cove", label: "Восточная бухта"};
  if (boat.y > 108) return {id: "north-inlet", label: "Северная заводь"};
  if (boat.y > 72) return {id: "north-channel", label: "Северный проход"};
  return {id: "south-channel", label: "Южный проход"};
}

function ensureV7State(state) {
  if (!state || typeof state !== "object") return state;
  ensureBayWorld(state);
  state.location ||= {};
  if (!("zoneId" in state.location)) state.location.zoneId = zoneAt(state.boat).id;
  if (!("hazardWarningId" in state.location)) state.location.hazardWarningId = null;
  if (!Number.isFinite(state.location.lastZoneAt)) state.location.lastZoneAt = -999;
  state.navigation ||= {};
  if (!("lockedTargetId" in state.navigation)) state.navigation.lockedTargetId = null;
  if (typeof state.navigation.assistEnabled !== "boolean") state.navigation.assistEnabled = state.mode !== "coop";
  return state;
}

function finalObjective(state, id = state.navigation.lockedTargetId) {
  if (id === "harbor" && state.rescued >= 2) return {...state.world.harbor, kind: "гавань"};
  const locked = state.world.survivors.find(item => item.id === id && !item.rescued);
  if (locked) return {...locked, kind: "человек"};
  const next = state.world.survivors
    .filter(item => !item.rescued)
    .map(item => ({...item, kind: "человек", metres: distance(state.boat, item)}))
    .sort((a, b) => a.metres - b.metres)[0];
  if (next) return next;
  return {...state.world.harbor, kind: "гавань"};
}

function guideTarget(state, objective) {
  if (!objective) return null;
  if (objective.id === "survivor-b") {
    const northGate = {id: "east-channel-north", label: "безопасный проход", kind: "проход", x: 25, y: 100, finalId: objective.id};
    const gateReached = distance(state.boat, northGate) <= 14;
    // Do not switch to the final survivor merely because the bow crossed an
    // invisible Y threshold. If the boat is still west of the gate, that
    // direct ray cuts through the middle ridge.
    if (state.boat.y < 88 || (!gateReached && state.boat.y < 108)) return northGate;
  }
  if (objective.id === "harbor") {
    if (state.boat.y > 105) return {id: "east-channel-return", label: "безопасный проход", kind: "проход", x: 25, y: 100, finalId: objective.id};
    if (state.boat.y > 58) return {id: "east-cove-return", label: "восточный проход", kind: "проход", x: 28, y: 55, finalId: objective.id};
    if (state.boat.y > 28) return {id: "harbor-east-gate", label: "вход в гавань", kind: "проход", x: 20, y: 22, finalId: objective.id};
  }
  return objective;
}

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  const tolerance = CONFIG.navigationCenterTolerance;
  const pan = Math.abs(relative) <= tolerance
    ? 0
    : clamp((relative - Math.sign(relative) * tolerance) / (80 - tolerance), -1, 1);
  return {distance: distance(state.boat, target), relative, pan, centered: Math.abs(relative) <= tolerance};
}

function directionText(relative) {
  const amount = Math.abs(relative);
  if (amount <= CONFIG.navigationCenterTolerance) return "прямо";
  const side = relative < 0 ? "слева" : "справа";
  if (amount <= 34) return `чуть ${side}`;
  return side;
}

function nearestHazard(state) {
  return state.world.hazards
    .map(hazard => ({hazard, ...bearingTo(state, hazard)}))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function solidifyHazards(state, previousPosition) {
  for (const hazard of state.world.hazards) {
    const safeRadius = hazard.radius + 2.35;
    let dx = state.boat.x - hazard.x;
    let dy = state.boat.y - hazard.y;
    let metres = Math.hypot(dx, dy);
    if (metres >= safeRadius) continue;
    if (metres < 0.001) {
      dx = previousPosition.x - hazard.x;
      dy = previousPosition.y - hazard.y;
      metres = Math.hypot(dx, dy) || 1;
    }
    const nx = dx / metres;
    const ny = dy / metres;
    state.boat.x = hazard.x + nx * (safeRadius + 0.35);
    state.boat.y = hazard.y + ny * (safeRadius + 0.35);
  }
}

function enforceShoreline(state, events) {
  const bounds = state.world.bounds;
  let side = null;
  if (state.boat.x < bounds.minX) { state.boat.x = bounds.minX + 0.8; side = "left"; }
  else if (state.boat.x > bounds.maxX) { state.boat.x = bounds.maxX - 0.8; side = "right"; }
  if (state.boat.y < bounds.minY) { state.boat.y = bounds.minY + 0.8; side ||= "back"; }
  else if (state.boat.y > bounds.maxY) { state.boat.y = bounds.maxY - 0.8; side ||= "front"; }
  if (!side) return;
  state.boat.speed *= -0.2;
  state.message = "Берег бухты. Лодка упёрлась в мелководье и оттолкнулась обратно.";
  events.push({type: "collision", severity: 0.55, pan: side === "left" ? -0.85 : side === "right" ? 0.85 : 0});
}

function updateLocationFeedback(state, events) {
  const critical = events.some(event => ["collision", "rescue-complete", "rope-progress", "rope-far", "rope-strain", "warning", "lose", "win"].includes(event.type));
  const zone = zoneAt(state.boat);
  if (!critical && zone.id !== state.location.zoneId && (state.totalElapsed || state.elapsed) - state.location.lastZoneAt > 2.5) {
    state.location.zoneId = zone.id;
    state.location.lastZoneAt = state.totalElapsed || state.elapsed;
    state.message = `Локация: ${zone.label}. Бухта конечная; берег находится слева, справа и впереди.`;
    events.push({type: "zone-enter", label: zone.label});
  }

  const hazard = nearestHazard(state);
  const inFront = hazard && hazard.distance <= CONFIG.hazardWarningRange && Math.abs(hazard.relative) <= 58;
  if (!critical && inFront && state.location.hazardWarningId !== hazard.hazard.id) {
    state.location.hazardWarningId = hazard.hazard.id;
    state.message = `Впереди ${hazard.hazard.label}, ${Math.round(hazard.distance)} метров. Уведи стереометку цели в сторону и обойди препятствие.`;
    events.push({type: "hazard-warning", pan: hazard.pan, distance: hazard.distance});
  } else if (!hazard || hazard.distance > CONFIG.hazardWarningRange + 12) {
    state.location.hazardWarningId = null;
  }
}

export function createGame(options = {}) {
  const state = ensureV7State(base.createGame(options));
  state.boat.x = 0;
  state.boat.y = 0;
  state.boat.heading = 0;
  state.boat.speed = 0;
  state.location.zoneId = "harbor-basin";
  state.navigation.lockedTargetId = null;
  return state;
}

export function startGame(state) {
  ensureV7State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message = "Ты в Южной гавани бухты Северный Приют. Нажми сонар один раз; затем веди лодку по стереописку. Двойной писк означает, что безопасный курс по центру.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  return base.setControl(ensureV7State(state), control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV7State(state);
  if (action === "assist-toggle") {
    const result = base.command(state, action, actor);
    if (result.ok && state.navigation.assistEnabled && !state.navigation.lockedTargetId) {
      state.message = "Навигационный писк включён. Нажми сонар один раз, чтобы закрепить цель.";
    }
    return result;
  }

  const result = base.command(state, action, actor);
  if (action === "sonar" && result.ok) {
    const objective = finalObjective(state);
    const bearing = bearingTo(state, objective);
    const guide = guideTarget(state, objective);
    state.navigation.lockedTargetId = objective.id;
    const routeText = guide.id === objective.id
      ? "Стереописк указывает на цель."
      : "Стереописк ведёт через безопасный проход, а не прямо через препятствия.";
    state.message = `Сонар: ${objectiveLabel(objective)} ${directionText(bearing.relative)}, ${Math.round(bearing.distance)} метров. ${routeText}`;
    result.events = (result.events || []).filter(event => event.type !== "hazard-ping");
  }
  return result;
}

export function step(state, dt) {
  ensureV7State(state);
  const previousPosition = {x: state.boat.x, y: state.boat.y};
  const assistEnabled = state.navigation.assistEnabled;
  state.navigation.assistEnabled = false;
  let events = base.step(state, dt) || [];
  state.navigation.assistEnabled = assistEnabled;
  events = events.filter(event => !PASSIVE_EVENTS.has(event.type));

  solidifyHazards(state, previousPosition);
  enforceShoreline(state, events);

  if (events.some(event => event.type === "rescue-complete")) {
    state.navigation.lockedTargetId = null;
    if (state.rescued < 2) state.message += " Нажми сонар один раз, чтобы закрепить следующего человека.";
    else state.message += " Нажми сонар один раз, чтобы закрепить обратный путь в Южную гавань.";
  }

  updateLocationFeedback(state, events);
  return events;
}

export function getView(state) {
  ensureV7State(state);
  const view = base.getView(state);
  const objective = state.navigation.lockedTargetId ? finalObjective(state) : null;
  const guide = objective ? guideTarget(state, objective) : null;
  const guideBearing = guide ? bearingTo(state, guide) : null;
  const objectiveBearing = objective ? bearingTo(state, objective) : null;
  const hazard = nearestHazard(state);
  const zone = zoneAt(state.boat);
  return {
    ...view,
    location: {
      name: state.world.name,
      zone: zone.label,
      bounds: {...state.world.bounds},
    },
    navigation: {
      ...view.navigation,
      assistEnabled: state.navigation.assistEnabled,
      lockedTargetId: state.navigation.lockedTargetId,
      targetKind: objective?.kind || null,
      targetLabel: objective ? objectiveLabel(objective) : null,
      targetDistance: objectiveBearing?.distance ?? null,
      targetRelativeAngle: guideBearing?.relative ?? null,
      guideDistance: guideBearing?.distance ?? null,
      guidePan: guideBearing?.pan ?? 0,
      guideCentered: guideBearing?.centered ?? false,
      guideIsWaypoint: Boolean(guide && objective && guide.id !== objective.id),
      nearestHazardDistance: hazard?.distance ?? null,
      nearestHazardRelativeAngle: hazard?.relative ?? null,
      nearestHazardPan: hazard?.pan ?? 0,
    },
  };
}

export function serialize(state) {
  return base.serialize(ensureV7State(state));
}

export function deserialize(value) {
  return ensureV7State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
