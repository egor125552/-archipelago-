"use strict";

import {
  tryMoveVesselOccupant,
  vesselOccupantWaterState,
} from "../vessel-deck-runtime.js";

const movementSnapshots = new WeakMap();
const waterModes = new WeakMap();

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 280) world.events.splice(0, world.events.length - 280);
}

function entryForBoat(nativeVessels, boatId) {
  return (nativeVessels || []).find(entry => entry?.boat?.id === boatId) || null;
}

function entryForPlayer(world, nativeVessels, playerIndex) {
  const boatId = world?.players?.[playerIndex]?.activeBoat;
  return Number.isInteger(boatId) ? entryForBoat(nativeVessels, boatId) : null;
}

function waterState(entry, playerIndex) {
  if (!entry?.instance?.occupants?.[playerIndex]) {
    return {mode: "dry", flooding: 0, depth: 0, damagePerSecond: 0, underwaterAcoustics: {}};
  }
  const raw = vesselOccupantWaterState(entry.definition, entry.instance, playerIndex);
  // vesselOccupantWaterState historically falls through to "wading" at exactly
  // zero flooding. Normalize that legacy edge here so dry decks stay dry.
  if ((Number(raw.flooding) || 0) <= 0.01 || (Number(raw.depth) || 0) <= 0.001) {
    return {...raw, mode: "dry", flooding: 0, depth: 0};
  }
  return raw;
}

function movementMultiplier(mode) {
  switch (mode) {
    case "ankle": return 0.82;
    case "wading": return 0.55;
    case "swimming": return 0.34;
    case "full": return 0.24;
    default: return 1;
  }
}

function modeText(mode) {
  if (mode === "ankle") return "Вода уже по щиколотку. Бежать становится тяжелее.";
  if (mode === "wading") return "Вода поднялась выше. Ты идёшь вброд, бежать уже не получается.";
  if (mode === "swimming") return "Вода поднялась до уровня плавания. Теперь по отсеку приходится плыть.";
  if (mode === "full") return "Отсек полностью затоплен. Ты плывёшь под водой и начинаешь терять здоровье.";
  return "Вода ушла. Снова можно нормально идти по отсеку.";
}

function modeMap(instance) {
  let map = waterModes.get(instance);
  if (!map) {
    map = new Map();
    waterModes.set(instance, map);
  }
  return map;
}

function publishWaterMode(world, record, state) {
  const player = world?.players?.[record.playerIndex];
  if (!player) return;

  player.vesselWaterMode = state.mode;
  player.vesselWaterDepth = Math.max(0, Number(state.depth) || 0);
  player.vesselWaterFlooding = clamp(state.flooding, 0, 100);
  player.vesselUnderwaterAcoustics = state.mode === "swimming" || state.mode === "full"
    ? {...(state.underwaterAcoustics || {})}
    : null;

  if (["wading", "swimming", "full"].includes(state.mode)) player.running = false;

  const modes = modeMap(record.entry.instance);
  const previous = modes.get(record.playerIndex);
  modes.set(record.playerIndex, state.mode);
  if (previous == null && state.mode === "dry") return;
  if (previous === state.mode) return;

  emit(
    world,
    "vessel-water-mobility",
    modeText(state.mode),
    [record.playerIndex],
    {
      sourcePlayer: record.playerIndex,
      boatId: record.entry.boat.id,
      deckId: record.entry.instance?.occupants?.[record.playerIndex]?.deckId || null,
      zoneId: record.entry.instance?.occupants?.[record.playerIndex]?.zoneId || null,
      waterMode: state.mode,
      flooding: clamp(state.flooding, 0, 100),
      depth: Math.max(0, Number(state.depth) || 0),
    },
  );
}

function limitWaterInput({world, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  const entry = entryForPlayer(world, nativeVessels, playerIndex);
  if (!entry?.definition?.capabilities?.walkableInterior) return;
  const state = waterState(entry, playerIndex);
  if (state.mode === "wading" || state.mode === "swimming" || state.mode === "full") {
    input.run = false;
  }
  if (state.mode === "swimming" || state.mode === "full") {
    input.jump = false;
  }
}

function captureWaterMovement({world, nativeVessels} = {}) {
  if (!world) return;
  const records = [];
  for (const entry of nativeVessels || []) {
    if (!entry?.definition?.capabilities?.walkableInterior) continue;
    for (const [rawIndex, local] of Object.entries(entry.instance?.occupants || {})) {
      const playerIndex = Number(rawIndex);
      const player = world.players?.[playerIndex];
      if (!Number.isInteger(playerIndex) || !player || player.activeBoat !== entry.boat.id) continue;
      records.push({
        entry,
        playerIndex,
        before: {
          deckId: local.deckId,
          zoneId: local.zoneId || null,
          x: Number(local.x) || 0,
          y: Number(local.y) || 0,
          heading: Number(local.heading) || 0,
          mode: local.mode || "walking",
        },
      });
    }
  }
  movementSnapshots.set(world, {eventStart: world.events?.length || 0, records});
}

function applyDrag(record, state) {
  const current = record.entry.instance?.occupants?.[record.playerIndex];
  if (!current || current.deckId !== record.before.deckId) return;
  const multiplier = movementMultiplier(state.mode);
  if (multiplier >= 0.999) return;

  const dx = (Number(current.x) || 0) - record.before.x;
  const dy = (Number(current.y) || 0) - record.before.y;
  if (Math.hypot(dx, dy) <= 0.0001) return;

  const desiredHeading = Number(current.heading) || record.before.heading;
  record.entry.instance.occupants[record.playerIndex] = {...record.before};
  tryMoveVesselOccupant(
    record.entry.definition,
    record.entry.instance,
    record.playerIndex,
    {x: dx * multiplier, y: dy * multiplier},
    {mode: state.mode === "swimming" || state.mode === "full" ? "swim" : "walk", heading: desiredHeading},
  );
}

function replaceFootstepsWithWater(world, snapshot, states) {
  const events = world.events || [];
  for (let index = snapshot.eventStart; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "footstep" || event.vesselDeck !== true) continue;
    const key = `${event.boatId}:${event.sourcePlayer}`;
    const state = states.get(key);
    if (!state || state.mode === "dry") continue;
    event.type = "splash";
    event.vesselDeckWater = true;
    event.waterMode = state.mode;
    event.waterDepth = Math.max(0, Number(state.depth) || 0);
    event.flooding = clamp(state.flooding, 0, 100);
  }
}

function clearInactivePlayerWaterState(world, activePlayers) {
  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    if (activePlayers.has(playerIndex)) continue;
    const player = world.players[playerIndex];
    if (!player) continue;
    player.vesselWaterMode = null;
    player.vesselWaterDepth = 0;
    player.vesselWaterFlooding = 0;
    player.vesselUnderwaterAcoustics = null;
  }
}

function applyWaterMovement({world} = {}) {
  if (!world) return;
  const snapshot = movementSnapshots.get(world);
  if (!snapshot) return;
  const activePlayers = new Set();
  const states = new Map();

  for (const record of snapshot.records) {
    const player = world.players?.[record.playerIndex];
    const current = record.entry.instance?.occupants?.[record.playerIndex];
    if (!player || player.activeBoat !== record.entry.boat.id || !current) continue;
    const state = waterState(record.entry, record.playerIndex);
    activePlayers.add(record.playerIndex);
    states.set(`${record.entry.boat.id}:${record.playerIndex}`, state);
    applyDrag(record, state);
    publishWaterMode(world, record, state);
  }

  replaceFootstepsWithWater(world, snapshot, states);
  clearInactivePlayerWaterState(world, activePlayers);
  movementSnapshots.delete(world);
}

export const VESSEL_WATER_MOBILITY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-water-mobility-before-input-v1",
    phase: "before-input",
    order: 4,
    run: limitWaterInput,
  }),
  Object.freeze({
    id: "vessel-water-mobility-capture-after-step-v1",
    phase: "after-step",
    order: 4,
    run: captureWaterMovement,
  }),
  Object.freeze({
    id: "vessel-water-mobility-apply-after-step-v1",
    phase: "after-step",
    order: 6,
    run: applyWaterMovement,
  }),
]);
