"use strict";

import {
  STRESS_TEST_ENGINE_COUNT,
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_REVERSE_SPEED,
} from "../stress-test-vessel-config.js?v=1";

export const STRESS_TEST_PHYSICS_ID = "stress-50-engine-physics-v1";
export {STRESS_TEST_ENGINE_COUNT, STRESS_TEST_MAX_SPEED, STRESS_TEST_REVERSE_SPEED};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = value => Number(value) * Math.PI / 180;

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

function crewForBoat(boat) {
  const crew = Array.isArray(boat?.crew) ? boat.crew.filter(Number.isInteger) : [];
  if (Number.isInteger(boat?.driver) && !crew.includes(boat.driver)) crew.unshift(boat.driver);
  return crew;
}

function disruptiveForBoat(world, boat, eventStart) {
  if (world?.tow && (world.tow.towerBoat === boat.id || world.tow.towedBoat === boat.id)) return true;
  const crew = new Set(crewForBoat(boat));
  return (world?.events || []).slice(eventStart).some(event => {
    if (!event || ![
      "collision",
      "ram",
      "water-boundary",
      "tow-attach",
      "tow-detach",
      "sonar-guide-snap",
    ].includes(event.type)) return false;
    if (Number.isInteger(event.boatId)) return event.boatId === boat.id;
    if (Number.isInteger(event.targetBoat)) return event.targetBoat === boat.id;
    return (event.targets || []).some(target => crew.has(target));
  });
}

function syncOccupants(world, boat) {
  for (const player of world?.players || []) {
    if (!player || !["boat", "roof"].includes(player.mode) || player.activeBoat !== boat.id) continue;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading;
  }
}

function rebuildCleanMotion(world, boat, before, safeDt) {
  const averageSpeed = ((Number(before.speed) || 0) + (Number(boat.speed) || 0)) * 0.5;
  const headingDelta = wrapDeg((Number(boat.heading) || 0) - (Number(before.heading) || 0));
  const averageHeading = wrapDeg((Number(before.heading) || 0) + headingDelta * 0.5);
  const radius = Math.max(1, Number(boat.collisionRadius) || 6);
  const width = Math.max(radius * 2, Number(world?.bounds?.width) || Number(world?.world?.width) || 420);
  const height = Math.max(radius * 2, Number(world?.bounds?.height) || Number(world?.world?.height) || 320);
  const shoreY = Number(world?.bounds?.shoreY) || Number(world?.world?.shoreY) || 72;
  boat.x = clamp((Number(before.x) || 0) + Math.sin(rad(averageHeading)) * averageSpeed * safeDt, radius, width - radius);
  boat.y = clamp((Number(before.y) || 0) - Math.cos(rad(averageHeading)) * averageSpeed * safeDt, shoreY + 4, height - radius);
  syncOccupants(world, boat);
}

export const STRESS_TEST_PHYSICS_MODULE = Object.freeze({
  id: STRESS_TEST_PHYSICS_ID,
  step({world, boat, definition, instance, dt, previousStates, eventStart = 0}) {
    if (!boat || boat.sunk || boat.reserved) return;
    const safeDt = clamp(dt, 0, 0.1);
    const installed = Math.max(1, propulsionModules(definition).length);
    const active = activePropulsionCount(definition, instance);
    const engineFraction = clamp(active / installed, 0, 1);
    boat.stressEngineCount = installed;
    boat.stressActiveEngineCount = active;
    exposePredictionProfile(boat, engineFraction);

    const before = previousStates?.[boat.id] || null;
    const ownsCleanMotion = Boolean(
      before
      && safeDt > 0
      && !boat.engineStalled
      && engineFraction > 0
      && !disruptiveForBoat(world, boat, eventStart)
    );

    // The shared legacy boat step still runs for compatibility before vessel
    // module physics. It must not become a second speed authority for this
    // module-driven vessel. Start from the real pre-legacy speed and rebuild
    // only clean linear motion. Real collisions, towing and boundary snaps stay
    // exactly where the legacy/contact systems resolved them.
    if (ownsCleanMotion) boat.speed = Number(before.speed) || 0;

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

    if (ownsCleanMotion) rebuildCleanMotion(world, boat, before, safeDt);
  },
});

export function installStressTestPhysicsModules(registry) {
  registry.registerPhysicsModule(STRESS_TEST_PHYSICS_MODULE);
}
