"use strict";

import {capturedVesselSharedInput} from "./vessel-deck-input-bridge-system.js?v=5";
import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

const pumpDeniedByWorld = new WeakMap();

function stateFor(world) {
  let state = pumpDeniedByWorld.get(world);
  if (!state) {
    state = new Set();
    pumpDeniedByWorld.set(world, state);
  }
  return state;
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

function pumpAvailable(entry) {
  const pump = entry?.instance?.modules?.["bilge-pump"];
  return Boolean(pump && pump.enabled !== false && (Number(pump.health) || 0) > 0 && !entry?.boat?.sunk);
}

function applyVesselFeedbackPolicy({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const events = world.events || [];
  const latched = stateFor(world);
  const remove = [];

  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;
    const boatId = entry.boat.id;
    const requested = pumpRequested(world, entry);
    const available = pumpAvailable(entry);

    // A released request or a repaired/re-enabled pump rearms the feedback.
    // If it later becomes unavailable again, that is a new state transition and
    // deserves one fresh warning even if the player never changed boats.
    if (!requested || available) {
      latched.delete(boatId);
      continue;
    }

    for (let index = Math.max(0, eventStart); index < events.length; index += 1) {
      const event = events[index];
      if (event?.type !== "vessel-pump-disabled" || event.boatId !== boatId) continue;
      if (latched.has(boatId)) remove.push(index);
      else latched.add(boatId);
    }
  }

  // Remove after scanning so indexes remain stable. This keeps the gameplay
  // event source intact while enforcing the accessibility contract at the
  // common vessel feedback boundary: one continuous failed action, one reason.
  for (const index of remove.sort((a, b) => b - a)) events.splice(index, 1);
}

export const VESSEL_FEEDBACK_POLICY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-feedback-policy-after-step-v1",
    phase: "after-step",
    order: 95,
    run: applyVesselFeedbackPolicy,
  }),
]);
