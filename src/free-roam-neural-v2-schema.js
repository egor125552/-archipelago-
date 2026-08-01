"use strict";

export const NEURAL_V2_FORMAT = "echo-tactical-gru-multihead-v2";

export const NEURAL_V2_THROTTLE_CLASSES = Object.freeze([
  "stop",
  "slow",
  "cruise",
  "full",
]);

export const NEURAL_V2_STEERING_CLASSES = Object.freeze([
  "hard_left",
  "left",
  "straight",
  "right",
  "hard_right",
]);

export const NEURAL_V2_RANGE_CLASSES = Object.freeze([
  "close",
  "medium",
  "far",
  "disengage",
]);

export const NEURAL_V2_ROUTE_CLASSES = Object.freeze([
  "direct",
  "safe_water",
  "shore_gate",
]);

export const NEURAL_V2_FIRE_CLASSES = Object.freeze([
  "hold_fire",
  "fire",
]);

export const NEURAL_V2_FEATURE_NAMES = Object.freeze([
  "alive",
  "health",
  "kind_boat",
  "kind_foot",
  "kind_turret",
  "role_heavy",
  "role_rammer",
  "role_gunboat",
  "role_landing",
  "role_other",
  "x",
  "y",
  "heading_sin",
  "heading_cos",
  "speed",
  "water_left",
  "water_right",
  "water_top",
  "water_bottom",
  "shore_gate_local_x",
  "shore_gate_local_y",
  "target_local_x",
  "target_local_y",
  "target_distance",
  "target_bearing_sin",
  "target_bearing_cos",
  "target_on_boat",
  "target_on_foot",
  "target_swimming",
  "target_on_land",
  "hull",
  "water",
  "leak",
  "fuel",
  "engine_health",
  "turret_health",
  "turret_aiming",
  "turret_bursting",
  "fire_cooldown",
  "near_boat_front",
  "near_boat_left",
  "near_boat_right",
  "collision_risk",
  "stuck_seconds",
  "active_enemy_count",
  "near_enemy_count",
  "threat_level",
  "elapsed",
  "previous_throttle",
  "previous_steering",
  "previous_range",
  "previous_route",
  "previous_fire",
]);

export const NEURAL_V2_INPUT_SIZE = NEURAL_V2_FEATURE_NAMES.length;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const indexOfClass = (classes, value, fallback = 0) => {
  if (Number.isInteger(value)) return Math.max(0, Math.min(classes.length - 1, value));
  const index = classes.indexOf(String(value || ""));
  return index >= 0 ? index : fallback;
};

function fireClassIndex(raw = {}) {
  const value = raw.fireIndex ?? raw.fire;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === "1") return 1;
  if (value === 0 || value === "0") return 0;
  return indexOfClass(NEURAL_V2_FIRE_CLASSES, value, 0);
}

export function normalizeNeuralV2Action(raw = {}) {
  const throttleIndex = indexOfClass(NEURAL_V2_THROTTLE_CLASSES, raw.throttleIndex ?? raw.throttle, 2);
  const steeringIndex = indexOfClass(NEURAL_V2_STEERING_CLASSES, raw.steeringIndex ?? raw.steering, 2);
  const rangeIndex = indexOfClass(NEURAL_V2_RANGE_CLASSES, raw.rangeIndex ?? raw.range, 1);
  const routeIndex = indexOfClass(NEURAL_V2_ROUTE_CLASSES, raw.routeIndex ?? raw.route, 1);
  const fireIndex = fireClassIndex(raw);
  return Object.freeze({
    throttleIndex,
    throttle: NEURAL_V2_THROTTLE_CLASSES[throttleIndex],
    steeringIndex,
    steering: NEURAL_V2_STEERING_CLASSES[steeringIndex],
    rangeIndex,
    range: NEURAL_V2_RANGE_CLASSES[rangeIndex],
    routeIndex,
    route: NEURAL_V2_ROUTE_CLASSES[routeIndex],
    fireIndex,
    fire: fireIndex === 1,
    source: String(raw.source || "v2-test").slice(0, 40),
  });
}

export function neuralV2ActionFeatureState(raw = {}) {
  const action = normalizeNeuralV2Action(raw);
  return [
    action.throttleIndex / Math.max(1, NEURAL_V2_THROTTLE_CLASSES.length - 1),
    action.steeringIndex / Math.max(1, NEURAL_V2_STEERING_CLASSES.length - 1),
    action.rangeIndex / Math.max(1, NEURAL_V2_RANGE_CLASSES.length - 1),
    action.routeIndex / Math.max(1, NEURAL_V2_ROUTE_CLASSES.length - 1),
    Number(action.fire),
  ];
}

export function neuralV2ThrottleScale(action) {
  const normalized = normalizeNeuralV2Action(action);
  return [0, 0.38, 0.7, 1][normalized.throttleIndex];
}

export function neuralV2SteeringOffset(action) {
  const normalized = normalizeNeuralV2Action(action);
  return [-88, -42, 0, 42, 88][normalized.steeringIndex];
}

export function neuralV2PreferredRange(action) {
  const normalized = normalizeNeuralV2Action(action);
  return [14, 38, 74, 118][normalized.rangeIndex];
}

export function validateNeuralV2FeatureVector(values) {
  if (!Array.isArray(values) || values.length !== NEURAL_V2_INPUT_SIZE) {
    throw new RangeError(`Neural v2 feature count ${values?.length ?? "none"} does not match ${NEURAL_V2_INPUT_SIZE}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(Number(values[index]))) throw new TypeError(`Neural v2 feature ${NEURAL_V2_FEATURE_NAMES[index]} is not finite`);
  }
  return values.map(value => clamp(value, -4, 4));
}
