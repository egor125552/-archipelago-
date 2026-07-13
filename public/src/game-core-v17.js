"use strict";

import * as base from "./game-core-v16.js?base=8";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  gromMaxSpeedMultiplier: 1.82,
  gromAccelerationMultiplier: 1.42,
  gromTurnRateMultiplier: 1.16,
  gromRepairPatches: 30,
  ropeApproachRange: 30,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function rescueTarget(state) {
  const locked = state.world?.survivors?.find(item => item.id === state.navigation?.lockedTargetId && !item.rescued);
  if (locked) return locked;
  return (state.world?.survivors || [])
    .filter(item => !item.rescued)
    .sort((left, right) => distance(state.boat, left) - distance(state.boat, right))[0] || null;
}

function tuneGrom(state) {
  if (state.boat?.modelId !== "grom") return;
  state.progression ||= {};
  if (state.progression.gromTuningVersion !== 17) {
    state.boat.repairPatches = Math.max(CONFIG.gromRepairPatches, Number(state.boat.repairPatches) || 0);
    state.progression.gromTuningVersion = 17;
  }
  state.boat.repairPatchCapacity = CONFIG.gromRepairPatches;
  state.boat.baseMaxSpeedMultiplier = CONFIG.gromMaxSpeedMultiplier;
  const debrisCount = state.debris?.pieces?.length || 0;
  state.boat.maxSpeedMultiplier = CONFIG.gromMaxSpeedMultiplier * clamp(1 - debrisCount * CONFIG.debrisSpeedPenalty, 0.62, 1);
  state.boat.accelerationMultiplier = CONFIG.gromAccelerationMultiplier;
  state.boat.turnRateMultiplier = CONFIG.gromTurnRateMultiplier;
  state.boat.engineHeatMultiplier = 0.8;
}

function ensureV17State(state) {
  if (!state || typeof state !== "object") return state;
  state.navigation ||= {};
  if (typeof state.navigation.ropeApproach !== "boolean") state.navigation.ropeApproach = false;
  tuneGrom(state);
  return state;
}

function bearingTo(state, target) {
  const absolute = deg(Math.atan2(target.x - state.boat.x, target.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  const centered = Math.abs(relative) <= CONFIG.navigationCenterTolerance;
  return {
    distance: distance(state.boat, target),
    absolute,
    relative,
    centered,
    pan: centered ? 0 : clamp(relative / 78, -1, 1),
  };
}

function turnToward(current, target, maximum) {
  return wrapDeg(current + clamp(wrapDeg(target - current), -maximum, maximum));
}

function prepareRopeApproach(state, dt, target, metres) {
  state.navigation.ropeApproach = true;
  state.navigation.approachAssist = true;
  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.rudder = 0;

  if (!state.controls.left && !state.controls.right) {
    const bearing = bearingTo(state, target);
    state.boat.heading = turnToward(state.boat.heading, bearing.absolute, 96 * dt);
  }

  const previous = Math.abs(Number(state.boat.speed) || 0);
  const allowed = clamp((metres - CONFIG.rescueRadius) * 0.72 + 0.7, 0.8, 7.2);
  const approachSpeed = clamp((metres - CONFIG.rescueRadius) * 0.52, 2.6, 5.2);
  let slowed = Math.min(previous * Math.exp(-4.8 * dt), allowed);
  if (!state.boat.engineStalled && !state.damageControl?.floodEmergency) {
    slowed = previous > approachSpeed
      ? Math.max(approachSpeed, slowed)
      : Math.min(approachSpeed, previous + 3.2 * dt);
  }
  state.boat.speed = slowed;
  if (metres <= CONFIG.rescueRadius) state.boat.speed = 0;
}

export function createGame(options = {}) {
  return ensureV17State(base.createGame(options));
}

export function startGame(state) {
  ensureV17State(state);
  base.startGame(state);
  tuneGrom(state);
  if (state.phase === "playing" && state.boat.modelId === "grom") {
    state.message = "Гром готов. 30 пластин, высокая скорость и усиленный таран.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV17State(state);
  const result = base.setControl(state, control, active, actor);
  if (result && control === "rescue" && active) {
    const target = rescueTarget(state);
    if (target && distance(state.boat, target) > CONFIG.rescueRadius) {
      state.message = "Трос готов. Лодка сама подойдёт и остановится.";
    }
  }
  return result;
}

export function command(state, action, actor = "captain") {
  ensureV17State(state);
  return base.command(state, action, actor);
}

export function step(state, dt) {
  ensureV17State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const target = rescueTarget(state);
  const ropeRequested = Boolean(state.controls.rescue && target);
  const metres = target ? distance(state.boat, target) : Infinity;
  const approach = ropeRequested && metres <= CONFIG.ropeApproachRange;
  state.navigation.ropeApproach = approach;
  if (approach) prepareRopeApproach(state, safeDt, target, metres);
  const autoThrust = approach
    && metres > CONFIG.rescueRadius
    && !state.boat.engineStalled
    && !state.damageControl?.floodEmergency;
  if (autoThrust) state.controls.forward = true;

  // A rope prepared at long range must not disable the normal beacon and
  // course hold. The request is restored after the underlying navigation step.
  const parkLongRope = ropeRequested && !approach;
  if (parkLongRope) state.controls.rescue = false;
  const events = base.step(state, safeDt) || [];
  if (autoThrust) {
    state.controls.forward = false;
    state.boat.throttle = 0;
  }
  const rescueFinished = events.some(event => event.type === "rescue-complete");
  if (parkLongRope && !rescueFinished && target && !target.rescued) state.controls.rescue = true;
  if (!state.controls.rescue || rescueFinished) state.navigation.ropeApproach = false;
  tuneGrom(state);
  return events;
}

export function getView(state) {
  ensureV17State(state);
  const view = base.getView(state);
  const target = rescueTarget(state);
  const bearing = target ? bearingTo(state, target) : null;
  const rescueMode = Boolean(
    target
    && bearing.distance <= CONFIG.rescueRadius
    && Math.abs(state.boat.speed) <= CONFIG.rescueSpeedLimit,
  );
  const centered = Boolean(state.navigation.courseHold || bearing?.centered);
  return {
    ...view,
    boat: {
      ...view.boat,
      repairPatches: state.boat.repairPatches,
      repairPatchCapacity: state.boat.repairPatchCapacity || 3,
      maxSpeedMultiplier: state.boat.maxSpeedMultiplier,
      accelerationMultiplier: state.boat.accelerationMultiplier,
      turnRateMultiplier: state.boat.turnRateMultiplier,
    },
    navigation: {
      ...view.navigation,
      ropeApproach: state.navigation.ropeApproach,
      rescueMode,
      guidePan: rescueMode || centered ? 0 : (bearing?.pan ?? view.navigation?.guidePan ?? 0),
      guideCentered: rescueMode || centered,
      beaconPan: rescueMode || centered ? 0 : (bearing?.pan ?? view.navigation?.beaconPan ?? 0),
      beaconCentered: rescueMode || centered,
      beaconSuppressed: rescueMode,
    },
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV17State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV17State(state));
}

export function deserialize(value) {
  return ensureV17State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
