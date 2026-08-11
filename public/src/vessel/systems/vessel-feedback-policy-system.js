"use strict";

import {capturedVesselSharedInput} from "./vessel-deck-input-bridge-system.js?v=5";
import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

const pumpDeniedByWorld = new WeakMap();
const pumpActiveBeforeByWorld = new WeakMap();

function denialStateFor(world) {
  let state = pumpDeniedByWorld.get(world);
  if (!state) {
    state = new Set();
    pumpDeniedByWorld.set(world, state);
  }
  return state;
}

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 280) world.events.splice(0, world.events.length - 280);
}

function crewIndices(entry) {
  const result = new Set();
  for (const raw of Object.keys(entry?.instance?.occupants || {})) {
    const playerIndex = Number(raw);
    if (Number.isInteger(playerIndex)) result.add(playerIndex);
  }
  for (const playerIndex of entry?.boat?.crew || []) if (Number.isInteger(playerIndex)) result.add(playerIndex);
  if (Number.isInteger(entry?.boat?.driver)) result.add(entry.boat.driver);
  return [...result];
}

function pumpRequested(world, entry) {
  return crewIndices(entry).some(playerIndex => {
    const captured = capturedVesselSharedInput(world, playerIndex);
    if (captured && Object.prototype.hasOwnProperty.call(captured, "pump")) return Boolean(captured.pump);
    return Boolean(
      world?.freeActivities?.inputs?.[playerIndex]?.pump
      || world?.operationInputs?.[playerIndex]?.pump
      || world?.inputs?.[playerIndex]?.pump
    );
  });
}

function pumpState(entry) {
  return entry?.instance?.modules?.["bilge-pump"] || null;
}

function pumpAvailable(entry) {
  const pump = pumpState(entry);
  return Boolean(
    pump
    && pump.enabled !== false
    && pump.repairActive !== true
    && (Number(pump.health) || 0) > 0
    && !entry?.boat?.sunk
  );
}

function pumpActuallyActive(entry) {
  const pump = pumpState(entry);
  return Boolean(
    pumpAvailable(entry)
    && pump?.active === true
    && entry?.boat?.pumpActive === true
  );
}

function pumpFailure(entry) {
  const pump = pumpState(entry);
  if (entry?.boat?.sunk) {
    return {reason: "sunk", text: "Насос включить невозможно: судно затонуло."};
  }
  if (pump?.repairActive === true) {
    return {reason: "repairing", text: "Насос включить невозможно: трюмная помпа сейчас ремонтируется."};
  }
  if (!pump || (Number(pump.health) || 0) <= 0) {
    return {reason: "damaged", text: "Насос включить невозможно: трюмная помпа повреждена. Спустись в машинное отделение и отремонтируй её."};
  }
  if (pump.enabled === false) {
    return {reason: "disabled", text: "Насос включить невозможно: трюмная помпа сейчас недоступна."};
  }
  return {reason: "unavailable", text: "Насос включить невозможно: трюмная помпа сейчас недоступна."};
}

function capturePumpActivity({world, nativeVessels} = {}) {
  if (!world) return;
  const snapshot = new Map();
  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;
    snapshot.set(entry.boat.id, pumpActuallyActive(entry));
  }
  pumpActiveBeforeByWorld.set(world, snapshot);
}

function applyVesselFeedbackPolicy({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const events = world.events || [];
  const latched = denialStateFor(world);
  const activeBefore = pumpActiveBeforeByWorld.get(world) || new Map();
  const remove = [];

  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;
    const boatId = entry.boat.id;
    const requested = pumpRequested(world, entry);
    const available = pumpAvailable(entry);
    const active = pumpActuallyActive(entry);

    // Starting a modular pump is a physical state transition, not a local UI
    // guess. Announce it only after the authoritative flooding system has made
    // the module active. Holding the request cannot repeat this transition.
    if (active && activeBefore.get(boatId) !== true) {
      emit(world, "vessel-pump-start", "Насос включён.", crewIndices(entry), {
        boatId,
        moduleId: "bilge-pump",
      });
    }

    // Normalize every denial at the shared vessel feedback boundary so future
    // vessel types get the same clear explanation without per-boat strings.
    const failure = pumpFailure(entry);
    for (let index = Math.max(0, eventStart); index < events.length; index += 1) {
      const event = events[index];
      if (event?.type !== "vessel-pump-disabled" || event.boatId !== boatId) continue;
      event.text = failure.text;
      event.reason = failure.reason;
      if (latched.has(boatId)) remove.push(index);
      else latched.add(boatId);
    }

    // A released request or a repaired/re-enabled pump rearms the feedback.
    // If it later becomes unavailable again, that is a new state transition and
    // deserves one fresh warning even if the player never changed boats.
    if (!requested || available) latched.delete(boatId);
  }

  // Remove after scanning so indexes remain stable. This keeps the gameplay
  // event source intact while enforcing the accessibility contract at the
  // common vessel feedback boundary: one continuous failed action, one reason.
  for (const index of remove.sort((a, b) => b - a)) events.splice(index, 1);
  pumpActiveBeforeByWorld.delete(world);
}

export const VESSEL_FEEDBACK_POLICY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-feedback-policy-before-step-v2",
    phase: "before-step",
    order: 49,
    run: capturePumpActivity,
  }),
  Object.freeze({
    id: "vessel-feedback-policy-after-step-v2",
    phase: "after-step",
    order: 95,
    run: applyVesselFeedbackPolicy,
  }),
]);
