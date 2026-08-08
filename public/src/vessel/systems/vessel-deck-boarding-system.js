"use strict";

const worldInputs = new WeakMap();
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function inputState(world) {
  let state = worldInputs.get(world);
  if (!state) {
    state = new Map();
    worldInputs.set(world, state);
  }
  return state;
}

function captureBoardingIntent({world, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  const state = inputState(world);
  const previous = state.get(playerIndex) || {action: false, pendingRise: false};
  const action = Boolean(input.action);
  state.set(playerIndex, {
    action,
    pendingRise: Boolean(previous.pendingRise || (action && !previous.action)),
  });
}

function boardingPoint(player, boat) {
  if (player?.mode === "roof" && player.activeBoat === boat?.id) return boat;
  return player;
}

function crewHasSpace(boat, playerIndex) {
  const capacity = Math.max(1, Math.floor(Number(boat?.crewCapacity) || 1));
  const crew = Array.isArray(boat?.crew) ? boat.crew : [];
  if (crew.includes(playerIndex)) return true;
  return crew.filter(Number.isInteger).length < capacity;
}

function addCrewMember(boat, playerIndex) {
  const capacity = Math.max(1, Math.floor(Number(boat?.crewCapacity) || 1));
  boat.crew = Array.isArray(boat.crew) ? boat.crew : [];
  while (boat.crew.length < capacity) boat.crew.push(null);
  if (boat.crew.includes(playerIndex)) return;
  const free = boat.crew.findIndex(value => !Number.isInteger(value));
  if (free >= 0) boat.crew[free] = playerIndex;
}

function actionWasConsumed(world, playerIndex) {
  return world?.freeActivities?.consumedActions?.[playerIndex] === true;
}

function playerCarriesCargo(player) {
  return Boolean(player?.combat?.carriedCrate);
}

function candidateDeckEntry(world, nativeVessels, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player || !["foot", "swim", "roof"].includes(player.mode)) return null;
  const candidates = [];
  for (const entry of nativeVessels || []) {
    const definition = entry?.definition;
    const boat = entry?.boat;
    if (!definition?.capabilities?.walkableInterior || definition.deckArchitecture?.boarding?.mode !== "deck-entry") continue;
    if (!boat || boat.sunk || boat.reserved || !crewHasSpace(boat, playerIndex)) continue;
    const point = boardingPoint(player, boat);
    const metres = distance(point, boat);
    const range = Math.max(1, Number(boat.boardingRange) || 13);
    if (metres > range) continue;
    candidates.push({entry, metres, owned: boat.owner === playerIndex});
  }
  candidates.sort((a, b) => Number(b.owned) - Number(a.owned) || a.metres - b.metres || a.entry.boat.id - b.entry.boat.id);
  return candidates[0]?.entry || null;
}

function emitEnter(world, entry, playerIndex) {
  const boat = entry.boat;
  const player = world.players[playerIndex];
  addCrewMember(boat, playerIndex);
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = Number(boat.x) || 0;
  player.y = Number(boat.y) || 0;
  player.heading = Number(boat.heading) || 0;
  world.events ||= [];
  world.events.push({
    type: "enter",
    text: `Ты поднялся на ${entry.definition.presentation?.label || boat.label || "судно"}.`,
    targets: [playerIndex],
    sourcePlayer: playerIndex,
    boatId: boat.id,
    x: player.x,
    y: player.y,
    at: world.time,
    operationEvent: true,
    deckEntry: true,
  });
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function finishDeckEntryBoarding({world, nativeVessels} = {}) {
  if (!world) return;
  const state = inputState(world);
  for (const [playerIndex, input] of state) {
    if (!input.pendingRise) continue;
    input.pendingRise = false;
    const player = world.players?.[playerIndex];
    if (!player || player.vesselDeckInputOwned === true || playerCarriesCargo(player)) continue;
    if (actionWasConsumed(world, playerIndex)) continue;
    const entry = candidateDeckEntry(world, nativeVessels, playerIndex);
    if (!entry) continue;
    emitEnter(world, entry, playerIndex);
  }
}

export const VESSEL_DECK_BOARDING_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-deck-boarding-before-input-v1", phase: "before-input", order: 1, run: captureBoardingIntent}),
  Object.freeze({id: "vessel-deck-boarding-after-step-v1", phase: "after-step", order: 1, run: finishDeckEntryBoarding}),
]);
