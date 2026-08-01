"use strict";

import {
  neuralV2PreferredRange,
  neuralV2SteeringOffset,
  neuralV2ThrottleScale,
  normalizeNeuralV2Action,
} from "./free-roam-neural-v2-schema.js";

const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;
const SHORE_GATE_MIN_X = 118;
const SHORE_GATE_MAX_X = 302;
const SHORE_GATE_Y = 88;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (left, right) => Math.hypot((Number(left?.x) || 0) - (Number(right?.x) || 0), (Number(left?.y) || 0) - (Number(right?.y) || 0));
const headingTo = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;

export function neuralV2RoleSpeed(actor) {
  if (actor?.kind === "foot") return 7.4;
  if (actor?.role === "heavy") return 11.5;
  if (actor?.role === "rammer" || actor?.role === "marauder") return 18.5;
  if (actor?.role === "interceptor") return 17;
  if (actor?.role === "gunboat") return 13.5;
  if (actor?.role === "landing") return 14;
  return 15;
}

export function neuralV2RoutePoint(actor, rawTargetPoint, rawAction) {
  const action = normalizeNeuralV2Action(rawAction);
  const target = {
    x: Number(rawTargetPoint?.x) || 0,
    y: Number(rawTargetPoint?.y) || 0,
  };
  if (actor?.kind !== "boat") return {...target, redirected: false, route: action.route};

  const targetOnLand = target.y < WATER_MIN_Y;
  if (action.route === "shore_gate") {
    return {
      x: clamp(target.x, SHORE_GATE_MIN_X, SHORE_GATE_MAX_X),
      y: SHORE_GATE_Y,
      redirected: true,
      route: "shore_gate",
    };
  }
  if (action.route === "safe_water") {
    return {
      x: clamp(target.x, WATER_MIN_X + 8, WATER_MAX_X - 8),
      y: clamp(target.y, WATER_MIN_Y + 8, WATER_MAX_Y - 8),
      redirected: targetOnLand || target.x < WATER_MIN_X || target.x > WATER_MAX_X || target.y > WATER_MAX_Y,
      route: "safe_water",
    };
  }
  return {...target, redirected: false, route: "direct"};
}

export function neuralV2DesiredMotion(actor, rawTargetPoint, rawAction) {
  const action = normalizeNeuralV2Action(rawAction);
  const entity = actor?.entity || actor || {};
  const routePoint = neuralV2RoutePoint(actor, rawTargetPoint, action);
  const targetHeading = headingTo(entity, routePoint);
  const metres = distance(entity, routePoint);
  const preferredRange = neuralV2PreferredRange(action);
  const steeringOffset = neuralV2SteeringOffset(action);
  const throttle = neuralV2ThrottleScale(action);
  const maximumSpeed = neuralV2RoleSpeed(actor);
  const tolerance = Math.max(5, preferredRange * 0.16);

  let radialMode = "orbit";
  let baseHeading = targetHeading;
  if (action.range === "disengage" || metres < preferredRange - tolerance) {
    radialMode = "retreat";
    baseHeading = wrapDeg(targetHeading + 180);
  } else if (metres > preferredRange + tolerance) {
    radialMode = "approach";
    baseHeading = targetHeading;
  }

  const orbitWeight = radialMode === "orbit" ? 1 : 0.45;
  const desiredHeading = wrapDeg(baseHeading + steeringOffset * orbitWeight);
  let speedScale = throttle;
  if (radialMode === "orbit") speedScale *= 0.86;
  if (metres < 8 && radialMode !== "retreat") speedScale *= 0.3;

  return {
    heading: desiredHeading,
    speed: maximumSpeed * speedScale,
    fire: action.fire,
    throttle: action.throttle,
    steering: action.steering,
    range: action.range,
    route: routePoint.route,
    routePoint,
    preferredRange,
    distance: metres,
    radialMode,
  };
}
