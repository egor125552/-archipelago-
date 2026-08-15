"use strict";

import {
  STRESS_TEST_ENGINE_COUNT,
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_REVERSE_SPEED,
} from "../stress-test-vessel-config.js?v=1";

export const STRESS_TEST_PHYSICS_ID = "stress-50-engine-physics-v1";
export {STRESS_TEST_ENGINE_COUNT, STRESS_TEST_MAX_SPEED, STRESS_TEST_REVERSE_SPEED};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function propulsionModules(definition) {
  return (definition?.modules || []).filter(module => module?.type === "propulsion");
}

function activePropulsionCount(definition, instance) {
  return propulsionModules(definition).filter(module => {
    const state = instance?.modules?.[module.id];
    return state && state.enabled !== false && (Number(state.health) || 0) > 0;
  }).length;
}

function engineResponseFactor(engineFraction) {
  return 0.2 + clamp(engineFraction, 0, 1) * 0.8;
}

function exposePredictionProfile(boat, engineFraction) {
  const response = engineResponseFactor(engineFraction);
  const propulsionAvailable = !boat.engineStalled && engineFraction > 0;
  const predictionLimitFraction = engineFraction > 0 ? engineFraction : 1;
  boat.predictionPhysicsProfile = {
    id: STRESS_TEST_PHYSICS_ID,
    source: "vessel-module",
    maxForwardSpeed: STRESS_TEST_MAX_SPEED * predictionLimitFraction,
    maxReverseSpeed: STRESS_TEST_REVERSE_SPEED * predictionLimitFraction,
    acceleration: 92 * response,
    deceleration: propulsionAvailable ? 118 * response : 110,
    releaseBehavior: "target-zero",
    applyDrag: false,
    propulsionAvailable,
  };
}

export const STRESS_TEST_PHYSICS_MODULE = Object.freeze({
  id: STRESS_TEST_PHYSICS_ID,
  step({boat, definition, instance, dt}) {
    if (!boat || boat.sunk || boat.reserved) return;
    const safeDt = clamp(dt, 0, 0.1);
    const installed = Math.max(1, propulsionModules(definition).length);
    const active = activePropulsionCount(definition, instance);
    const engineFraction = clamp(active / installed, 0, 1);
    boat.stressEngineCount = installed;
    boat.stressActiveEngineCount = active;
    exposePredictionProfile(boat, engineFraction);

    if (boat.engineStalled || engineFraction <= 0 || safeDt <= 0) {
      boat.speed += clamp(-boat.speed, -110 * safeDt, 110 * safeDt);
      return;
    }

    const throttle = clamp(boat.throttle, -1, 1);
    const forwardMaximum = STRESS_TEST_MAX_SPEED * engineFraction;
    const reverseMaximum = STRESS_TEST_REVERSE_SPEED * engineFraction;
    const targetSpeed = throttle >= 0 ? throttle * forwardMaximum : throttle * reverseMaximum;
    const accelerating = Math.abs(targetSpeed) > Math.abs(Number(boat.speed) || 0);
    const rate = (accelerating ? 92 : 118) * engineResponseFactor(engineFraction);
    boat.speed += clamp(targetSpeed - boat.speed, -rate * safeDt, rate * safeDt);
    boat.speed = clamp(boat.speed, -reverseMaximum, forwardMaximum);
  },
});

export function installStressTestPhysicsModules(registry) {
  registry.registerPhysicsModule(STRESS_TEST_PHYSICS_MODULE);
}