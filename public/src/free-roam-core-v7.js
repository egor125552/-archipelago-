"use strict";

import * as base from "./free-roam-core-v6.js?v=1";

export * from "./free-roam-core-v6.js?v=1";
export const WORLD = base.WORLD;

function targetForBoat(boat) {
  return boat?.driver ?? boat?.owner;
}

export function setPlayerInput(world, playerIndex, nextInput) {
  base.setPlayerInput(world, playerIndex, nextInput);
  const navigationTargetId = typeof nextInput?.navigationTargetId === "string"
    ? nextInput.navigationTargetId.slice(0, 80)
    : null;
  if (navigationTargetId && world?.freeActivities?.inputs?.[playerIndex]) {
    world.freeActivities.inputs[playerIndex].navigationTargetId = navigationTargetId;
  }
}

export function stepFreeWorld(world, dt) {
  const before = (world?.boats || []).map(boat => ({
    refuelActive: Boolean(boat?.refuelActive),
    refuelCanisters: Math.max(0, Math.floor(Number(boat?.refuelCanisters) || 0)),
  }));
  const eventStart = world?.events?.length || 0;
  const result = base.stepFreeWorld(world, dt);
  const freshEvents = (world?.events || []).slice(eventStart);
  const usedEvents = new Set();

  for (let index = 0; index < (world?.boats || []).length; index += 1) {
    const boat = world.boats[index];
    const previous = before[index];
    if (!boat || !previous?.refuelActive || boat.refuelActive) continue;
    const remaining = Math.max(0, Math.floor(Number(boat.refuelCanisters) || 0));
    if (remaining !== Math.max(0, previous.refuelCanisters - 1)) continue;

    const target = targetForBoat(boat);
    const completed = freshEvents.find(event => (
      !usedEvents.has(event)
      && event?.type === "fuel-refuel-complete"
      && (!Array.isArray(event.targets) || event.targets.includes(target))
    ));
    if (!completed) continue;

    usedEvents.add(completed);
    boat.fuel = 100;
    boat.fuelEmptyAnnounced = false;
    completed.fuel = 100;
    completed.text = "Заправка завершена. Топливо 100%.";
  }

  return result;
}
