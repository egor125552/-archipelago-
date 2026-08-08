"use strict";

const pendingByWorld = new WeakMap();

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

function captureDeckCombatInput({world, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  const state = pending(world);
  if (!liveDeckEntry(world, nativeVessels, playerIndex)) {
    state.delete(playerIndex);
    return;
  }
  state.set(playerIndex, {attack: Boolean(input.attack)});
}

function restoreDeckCombatInput({world, nativeVessels, playerIndex} = {}) {
  if (!world || !Number.isInteger(playerIndex)) return;
  const state = pending(world).get(playerIndex);
  if (!state || !liveDeckEntry(world, nativeVessels, playerIndex)) return;
  if (world.inputs?.[playerIndex]) world.inputs[playerIndex].attack = state.attack;
  if (world.operationInputs?.[playerIndex]) world.operationInputs[playerIndex].attack = state.attack;
  if (world.freeActivities?.inputs?.[playerIndex]) world.freeActivities.inputs[playerIndex].attack = state.attack;
}

export const VESSEL_DECK_INPUT_BRIDGE_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-deck-input-bridge-before-input-v1", phase: "before-input", order: 4, run: captureDeckCombatInput}),
  Object.freeze({id: "vessel-deck-input-bridge-after-input-v1", phase: "after-input", order: 4, run: restoreDeckCombatInput}),
]);
