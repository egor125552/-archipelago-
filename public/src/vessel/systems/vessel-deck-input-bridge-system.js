"use strict";

import {claimedVesselStation, stationOwnsInput} from "../vessel-authority.js?v=1";

const pendingByWorld = new WeakMap();
const CARGO_ACTION_RANGE = 12;
const SHARED_FIELDS = Object.freeze(["attack", "pump", "repair", "guide"]);
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function pending(world) {
  let value = pendingByWorld.get(world);
  if (!value) {
    value = new Map();
    pendingByWorld.set(world, value);
  }
  return value;
}

function liveDeckEntry(world, nativeVessels, playerIndex) {
  const boatId = world?.players?.[playerIndex]?.activeBoat;
  if (!Number.isInteger(boatId)) return null;
  return (nativeVessels || []).find(entry => entry?.boat?.id === boatId
    && entry?.definition?.deckArchitecture?.enabled === true
    && entry?.instance?.occupants?.[playerIndex]) || null;
}

function cargoActionAvailable(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player) return false;
  if (player.combat?.carriedCrate) return true;
  return (world?.freeActivities?.crates || []).some(crate => crate?.state === "world" && distance(player, crate) <= CARGO_ACTION_RANGE);
}

function captureDeckSharedInput({world, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  const state = pending(world);
  const entry = liveDeckEntry(world, nativeVessels, playerIndex);
  if (!entry) {
    state.delete(playerIndex);
    return;
  }

  const cargoAction = Boolean(input.action && cargoActionAvailable(world, playerIndex));
  const occupiedStation = claimedVesselStation(entry, playerIndex);
  state.set(playerIndex, {
    attack: Boolean(input.attack),
    pump: Boolean(input.pump),
    repair: Boolean(input.repair),
    guide: Boolean(input.guide),
    cargoAction,
  });

  // One physical button press must have one owner. While a player occupies any
  // vessel station, a valid nearby cargo action belongs to the shared cargo
  // system and must not simultaneously reach the deck interaction runtime as
  // "leave station". The same button still leaves the station normally when
  // there is no cargo operation available.
  if (cargoAction && occupiedStation) input.action = false;
}

export function capturedVesselSharedInput(world, playerIndex) {
  const value = pendingByWorld.get(world)?.get(Number(playerIndex));
  return value ? {...value} : null;
}

function restoreField(world, playerIndex, key, value) {
  if (world.inputs?.[playerIndex]) world.inputs[playerIndex][key] = value;
  if (world.operationInputs?.[playerIndex]) world.operationInputs[playerIndex][key] = value;
  if (world.freeActivities?.inputs?.[playerIndex]) world.freeActivities.inputs[playerIndex][key] = value;
}

function suppressLegacyPreviousField(world, playerIndex, key) {
  if (world.previousInputs?.[playerIndex]) world.previousInputs[playerIndex][key] = false;
  if (world.operationPreviousInputs?.[playerIndex]) world.operationPreviousInputs[playerIndex][key] = false;
  if (world.freeActivities?.previousInputs?.[playerIndex]) world.freeActivities.previousInputs[playerIndex][key] = false;
}

function restoreDeckSharedInput({world, nativeVessels, playerIndex} = {}) {
  if (!world || !Number.isInteger(playerIndex)) return;
  const state = pending(world).get(playerIndex);
  const entry = liveDeckEntry(world, nativeVessels, playerIndex);
  if (!state || !entry) return;

  // A shared control is restored to legacy gameplay only when no occupied
  // vessel station owns that action. Ownership includes previous input state:
  // a trigger that changes hands must not look like a personal-weapon release
  // on the same frame (which could otherwise create a stray melee attack).
  for (const field of SHARED_FIELDS) {
    if (stationOwnsInput(entry, playerIndex, field)) {
      suppressLegacyPreviousField(world, playerIndex, field);
      continue;
    }
    restoreField(world, playerIndex, field, state[field]);
  }
  if (state.cargoAction) restoreField(world, playerIndex, "action", true);
}

export const VESSEL_DECK_INPUT_BRIDGE_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-deck-input-bridge-before-input-v4", phase: "before-input", order: 4, run: captureDeckSharedInput}),
  Object.freeze({id: "vessel-deck-input-bridge-after-input-v4", phase: "after-input", order: 4, run: restoreDeckSharedInput}),
]);
