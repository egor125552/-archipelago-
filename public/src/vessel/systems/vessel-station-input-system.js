"use strict";

const LOCKED_FIELDS = Object.freeze(["up", "down", "left", "right", "run", "jump"]);
const pendingByWorld = new WeakMap();

function entryForPlayer(world, nativeVessels, playerIndex) {
  const boatId = world?.players?.[playerIndex]?.activeBoat;
  if (!Number.isInteger(boatId)) return null;
  return (nativeVessels || []).find(entry => entry?.boat?.id === boatId) || null;
}

function claimedStation(entry, playerIndex) {
  const claims = entry?.instance?.interior?.claims || {};
  for (const deck of entry?.definition?.decks || []) {
    for (const object of deck.objects || []) {
      if (object?.kind !== "station") continue;
      const resourceId = String(object.resourceId || object.id);
      if (claims[resourceId] !== playerIndex) continue;
      return object;
    }
  }
  return null;
}

function isMovementLockedStation(station) {
  if (!station || station.locksMovement === false) return false;
  if (station.controlsVessel === true || station.stationRole === "helm") return false;
  return true;
}

function saveFields(input) {
  const saved = {};
  for (const field of LOCKED_FIELDS) {
    saved[field] = {
      present: Object.prototype.hasOwnProperty.call(input || {}, field),
      value: input?.[field],
    };
  }
  return saved;
}

function suppressFields(input) {
  if (!input) return;
  for (const field of LOCKED_FIELDS) input[field] = false;
}

function restoreFields(input, saved) {
  if (!input || !saved) return;
  for (const field of LOCKED_FIELDS) {
    const state = saved[field];
    if (!state?.present) continue;
    input[field] = state.value;
  }
}

function inputStores(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function pendingMap(world) {
  let map = pendingByWorld.get(world);
  if (!map) {
    map = new Map();
    pendingByWorld.set(world, map);
  }
  return map;
}

function beforeInput({world, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  const entry = entryForPlayer(world, nativeVessels, playerIndex);
  const station = claimedStation(entry, playerIndex);
  if (!isMovementLockedStation(station)) return;

  const saved = saveFields(input);
  const touched = [...new Set([input, ...inputStores(world, playerIndex)])];
  const snapshots = touched.map(target => [target, saveFields(target)]);
  for (const target of touched) suppressFields(target);
  pendingMap(world).set(playerIndex, {saved, snapshots});
}

function afterInput({world, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex)) return;
  const map = pendingByWorld.get(world);
  const pending = map?.get(playerIndex);
  if (!pending) return;
  map.delete(playerIndex);
  if (!map.size) pendingByWorld.delete(world);

  for (const [target, saved] of pending.snapshots) restoreFields(target, saved);
  restoreFields(input, pending.saved);
  for (const target of inputStores(world, playerIndex)) restoreFields(target, pending.saved);

  const entry = entryForPlayer(world, nativeVessels, playerIndex);
  const station = claimedStation(entry, playerIndex);
  if (!isMovementLockedStation(station)) {
    const raw = entry?.instance?.interior?.walkableControl?.inputs?.[String(playerIndex)];
    restoreFields(raw, pending.saved);
  }
}

export const VESSEL_STATION_INPUT_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-station-input-guard-before-input-v1",
    phase: "before-input",
    order: 0,
    run: beforeInput,
  }),
  Object.freeze({
    id: "vessel-station-input-guard-after-input-v1",
    phase: "after-input",
    order: 90,
    run: afterInput,
  }),
]);
