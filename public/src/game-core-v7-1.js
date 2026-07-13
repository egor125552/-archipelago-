"use strict";

import * as base from "./game-core-v7.js?base=1";

export const CONFIG = base.CONFIG;

export const createGame = base.createGame;
export const startGame = base.startGame;
export const setControl = base.setControl;
export const command = base.command;
export const getView = base.getView;
export const serialize = base.serialize;
export const deserialize = base.deserialize;
export const nearestSurvivor = base.nearestSurvivor;

export function step(state, dt) {
  const previousMessage = state.message;
  const events = base.step(state, dt) || [];
  const view = base.getView(state);
  const angle = Math.abs(view.navigation?.nearestHazardRelativeAngle ?? 180);
  const falseSideWarning = events.some(event => event.type === "hazard-warning") && angle > 28;
  if (!falseSideWarning) return events;
  state.message = previousMessage;
  if (state.location) state.location.hazardWarningId = null;
  return events.filter(event => event.type !== "hazard-warning");
}
