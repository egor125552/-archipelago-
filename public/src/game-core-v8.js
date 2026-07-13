"use strict";

import * as base from "./game-core-v7-1.js?base=4";
import {applyCollisionDamage, collisionSeverity} from "./collision-model.js";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  navigationCenterTolerance: 10,
  collisionMargin: 2.6,
  locationHazardRange: 46,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const SILENT_EVENTS = new Set(["zone-enter", "hazard-warning", "navigation-cue", "proximity", "turn-progress"]);
const CRITICAL_EVENTS = new Set([
  "collision", "rescue-complete", "rope-progress", "rope-far", "rope-strain",
  "warning", "engine-stall", "lose", "win", "hull-repair-complete", "repair-blocked",
]);

function elapsed(state) {
  return Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;
}

function ensureV8State(state) {
  if (!state || typeof state !== "object") return state;
  state.navigation ||= {};
  if (!("captureReadyId" in state.navigation)) state.navigation.captureReadyId = null;
  if (!("lastSonarTargetId" in state.navigation)) state.navigation.lastSonarTargetId = null;
  state.location ||= {};
  if (!Number.isFinite(state.location.lastQuietUpdateAt)) state.location.lastQuietUpdateAt = -999;
  return state;
}

function objectiveFor(state, id = state.navigation.lockedTargetId) {
  if (id === "harbor" && state.rescued >= 2) return {...state.world.harbor, kind: "гавань"};
  const locked = state.world.survivors.find(item => item.id === id && !item.rescued);
  if (locked) return {...locked, kind: "человек"};
  const survivor = state.world.survivors
    .filter(item => !item.rescued)
    .map(item => ({...item, kind: "человек", metres: distance(state.boat, item)}))
    .sort((a, b) => a.metres - b.metres)[0];
  return survivor || {...state.world.harbor, kind: "гавань"};
}

function objectiveLabel(target) {
  if (!target) return "цель";
  if (target.id === "survivor-a") return "первый человек";
  if (target.id === "survivor-b") return "второй человек";
  if (target.id === "harbor") return "Южная гавань";
  return target.label || target.kind || "цель";
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
  return amount <= 34 ? `чуть ${side}` : side;
}

function zoneDescription(zone) {
  switch (zone) {
    case "Южная гавань": return "защищённая стартовая гавань у южного берега";
    case "Восточная бухта": return "небольшая восточная бухта, где находится первый человек";
    case "Северная заводь": return "северная заводь со вторым человеком";
    case "Северный проход": return "узкий проход между каменной грядой и восточным рифом";
    default: return "южный проход от гавани к Восточной бухте";
  }
}

function nearestHazard(state) {
  return state.world.hazards
    .map(hazard => ({hazard, ...bearingTo(state, hazard)}))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function nearestShore(state) {
  const bounds = state.world.bounds;
  return [
    {name: "западного берега", distance: state.boat.x - bounds.minX},
    {name: "восточного берега", distance: bounds.maxX - state.boat.x},
    {name: "южного берега", distance: state.boat.y - bounds.minY},
    {name: "северного берега", distance: bounds.maxY - state.boat.y},
  ].sort((a, b) => a.distance - b.distance)[0];
}

function describeLocation(state) {
  const view = base.getView(state);
  const zone = view.location?.zone || "неизвестная часть бухты";
  const target = objectiveFor(state);
  const targetBearing = bearingTo(state, target);
  const hazard = nearestHazard(state);
  const shore = nearestShore(state);
  const hazardText = hazard && hazard.distance <= CONFIG.locationHazardRange
    ? ` Ближайшее препятствие: ${hazard.hazard.label || (hazard.hazard.type === "reef" ? "риф" : "обломки")} ${directionText(hazard.relative)}, ${Math.round(hazard.distance)} метров.`
    : " Рядом крупных препятствий нет.";
  return `Ты в локации ${zone}: ${zoneDescription(zone)}. ${objectiveLabel(target)} ${directionText(targetBearing.relative)}, ${Math.round(targetBearing.distance)} метров. До ${shore.name} около ${Math.max(0, Math.round(shore.distance))} метров.${hazardText}`;
}

function firstRescueTutorial() {
  return "Как спасти первого человека. Первое: нажми сонар один раз. Второе: следуй высокому стереомаяку; перед каждой сменой контрольной точки прозвучит голосовое сообщение. Третье: примерно за двадцать метров отпусти газ и тормози. Когда человек ближе четырнадцати метров, а скорость не выше четырёх узлов, маяк замолчит. Один раз нажми Подать спасательный трос: лодка остановится и будет удерживаться до завершения спасения.";
}

function segmentCircleEntry(start, end, circle, radius) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fx = start.x - circle.x;
  const fy = start.y - circle.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter(t => t >= 0 && t <= 1)
    .sort((x, y) => x - y);
  return candidates[0] ?? null;
}

function keepObstacleSolid(state, previous, previousSpeed, collisionTimes, events) {
  const end = {x: state.boat.x, y: state.boat.y};
  const segmentLength = distance(previous, end);
  for (const hazard of state.world.hazards) {
    const radius = hazard.radius + CONFIG.collisionMargin;
    const startedOutside = distance(previous, hazard) >= radius - 0.05;
    const entry = startedOutside ? segmentCircleEntry(previous, end, hazard, radius) : null;
    const endedInside = distance(end, hazard) < radius;
    if (entry == null && !endedInside) continue;

    let contactX;
    let contactY;
    if (entry != null && segmentLength > 0.001) {
      const back = Math.min(0.035, 0.45 / segmentLength);
      const t = Math.max(0, entry - back);
      contactX = previous.x + (end.x - previous.x) * t;
      contactY = previous.y + (end.y - previous.y) * t;
    } else {
      contactX = previous.x;
      contactY = previous.y;
    }

    let nx = contactX - hazard.x;
    let ny = contactY - hazard.y;
    let length = Math.hypot(nx, ny);
    if (length < 0.001) {
      nx = previous.x - hazard.x;
      ny = previous.y - hazard.y;
      length = Math.hypot(nx, ny) || 1;
    }
    state.boat.x = hazard.x + nx / length * (radius + 0.25);
    state.boat.y = hazard.y + ny / length * (radius + 0.25);

    const collidedInBase = (state.collisions[hazard.id] ?? -999) !== (collisionTimes[hazard.id] ?? -999);
    if (!collidedInBase && elapsed(state) - (state.collisions[hazard.id] ?? -999) > 1.25) {
      state.collisions[hazard.id] = elapsed(state);
      const impactSpeed = Math.abs(previousSpeed);
      const severity = collisionSeverity(impactSpeed);
      const impact = applyCollisionDamage(state.boat, hazard.damage * severity);
      events.push({
        type: "collision",
        severity,
        damage: impact.damage,
        absorbed: impact.absorbed,
        armor: impact.armor,
        impactSpeed,
        pan: bearingTo(state, hazard).pan,
        hazardId: hazard.id,
      });
    }

    // A held mobile control must not keep feeding the engine into the same
    // contact until numerical correction eventually appears to cross it.
    // Stop at the near face and require a fresh steering/throttle gesture.
    state.controls.forward = false;
    state.controls.reverse = false;
    state.boat.speed = 0;
    state.boat.throttle = 0;
    const collision = [...events].reverse().find(event => event.type === "collision" && (!event.hazardId || event.hazardId === hazard.id));
    const damageText = collision?.damage > 0 ? ` Потеря корпуса: ${Math.round(collision.damage)} процентов.` : "";
    const armorText = collision?.absorbed > 0 ? ` Броня поглотила ${Math.round(collision.absorbed)}.` : "";
    state.message = `Удар о ${hazard.label || (hazard.type === "reef" ? "риф" : "обломки")}.${damageText}${armorText} Лодка остановлена с этой стороны препятствия. Отверни и снова дай газ.`;
  }
}

function updateCaptureReady(state, events) {
  const target = objectiveFor(state);
  if (!target || target.id === "harbor") {
    state.navigation.captureReadyId = null;
    return;
  }
  const metres = distance(state.boat, target);
  const ready = metres <= base.CONFIG.rescueRadius && Math.abs(state.boat.speed) <= base.CONFIG.rescueSpeedLimit;
  if (ready && state.navigation.captureReadyId !== target.id && !state.controls.rescue) {
    state.navigation.captureReadyId = target.id;
    state.message = `${objectiveLabel(target)} рядом. Скорость подходит. Один раз нажми Подать спасательный трос.`;
    events.push({type: "capture-ready", pan: bearingTo(state, target).pan});
  } else if (!ready && metres > base.CONFIG.rescueRadius + 3) {
    state.navigation.captureReadyId = null;
  }
}

export function createGame(options = {}) {
  return ensureV8State(base.createGame(options));
}

export function startGame(state) {
  ensureV8State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    state.message = "Ты в конечной бухте Северный Приют, в Южной гавани. Нажми сонар один раз. После этого голос замолчит, а высокий стереописк будет вести к первому человеку.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  return base.setControl(ensureV8State(state), control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV8State(state);
  if (action === "where") {
    state.message = describeLocation(state);
    return {ok: true, events: [{type: "location-report"}]};
  }
  if (action === "tutorial-first") {
    state.message = firstRescueTutorial();
    return {ok: true, events: [{type: "tutorial"}]};
  }

  const result = base.command(state, action, actor);
  if (action === "sonar" && result.ok) {
    const target = objectiveFor(state, state.navigation.lockedTargetId);
    const direct = bearingTo(state, target);
    const view = base.getView(state);
    const navigation = view.navigation || {};
    const routeAngle = Number.isFinite(navigation.targetRelativeAngle)
      ? navigation.targetRelativeAngle
      : direct.relative;
    const routeDistance = Number.isFinite(navigation.guideDistance)
      ? navigation.guideDistance
      : direct.distance;
    const routePan = Number.isFinite(navigation.guidePan) ? navigation.guidePan : direct.pan;
    const routeIsWaypoint = Boolean(navigation.guideIsWaypoint);
    const routeLabel = routeIsWaypoint ? "безопасный проход" : objectiveLabel(target);
    const destination = routeIsWaypoint
      ? ` Сама цель находится примерно в ${Math.round(direct.distance)} метрах; после прохода маяк автоматически довернёт к ней.`
      : "";
    state.navigation.lastSonarTargetId = target.id;
    state.sonar.lastResult = {
      ...(state.sonar.lastResult || {}),
      id: target.id,
      objectiveDistance: direct.distance,
      distance: routeDistance,
      relativeAngle: routeAngle,
      pan: routePan,
      routeIsWaypoint,
    };
    state.message = `Сонар. Маршрут: ${routeLabel} ${directionText(routeAngle)}, ${Math.round(routeDistance)} метров.${destination} Высокий стереомаяк показывает то же направление; двойной писк по центру означает правильный курс.`;
    result.events = (result.events || [])
      .filter(event => event.type !== "hazard-ping")
      .map(event => ["sonar", "sonar-lock"].includes(event.type)
        ? {...event, pan: routePan, distance: routeDistance, relativeAngle: routeAngle, routeIsWaypoint}
        : event);
  }
  return result;
}

export function step(state, dt) {
  ensureV8State(state);
  const previousMessage = state.message;
  const previous = {x: state.boat.x, y: state.boat.y};
  const previousSpeed = Number(state.boat.speed) || 0;
  const collisionTimes = {...state.collisions};
  let events = base.step(state, dt) || [];

  keepObstacleSolid(state, previous, previousSpeed, collisionTimes, events);

  const hasCritical = events.some(event => CRITICAL_EVENTS.has(event.type));
  const onlySilentLocationFeedback = !hasCritical && events.some(event => SILENT_EVENTS.has(event.type));
  if (onlySilentLocationFeedback) state.message = previousMessage;
  events = events.filter(event => !SILENT_EVENTS.has(event.type));

  updateCaptureReady(state, events);
  return events;
}

export function getView(state) {
  ensureV8State(state);
  const view = base.getView(state);
  const target = state.navigation.lockedTargetId ? objectiveFor(state) : null;
  const targetBearing = target ? bearingTo(state, target) : null;
  const hazard = nearestHazard(state);
  const shore = nearestShore(state);
  return {
    ...view,
    location: {
      ...view.location,
      description: zoneDescription(view.location?.zone),
      nearestShore: shore.name,
      nearestShoreDistance: shore.distance,
    },
    navigation: {
      ...view.navigation,
      directTargetDistance: targetBearing?.distance ?? null,
      directTargetRelativeAngle: targetBearing?.relative ?? null,
      beaconPan: view.navigation?.guideCentered ? 0 : (view.navigation?.guidePan ?? 0),
      beaconCentered: Boolean(view.navigation?.guideCentered),
      centerTolerance: CONFIG.navigationCenterTolerance,
      captureReady: state.navigation.captureReadyId != null,
      nearestHazardLabel: hazard?.hazard?.label || null,
    },
  };
}

export function serialize(state) {
  return base.serialize(ensureV8State(state));
}

export function deserialize(value) {
  return ensureV8State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
