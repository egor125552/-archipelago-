"use strict";

import * as base from "./game-core-v9.js?base=2";

export const CONFIG = base.CONFIG;
export const createGame = base.createGame;
export const startGame = base.startGame;
export const setControl = base.setControl;
export const step = base.step;
export const getView = base.getView;
export const serialize = base.serialize;
export const deserialize = base.deserialize;
export const nearestSurvivor = base.nearestSurvivor;

export function command(state, action, actor = "captain") {
  const result = base.command(state, action, actor);
  if (action === "anchor" && result.ok) {
    const direction = Math.sign(state.boat.speed || 0);
    state.boat.speed = direction * Math.min(0.12, Math.abs(state.boat.speed) * 0.08);
    state.boat.throttle = 0;
    state.message = "Плавучий тормоз сброшен. Лодка почти остановилась; обычное отпускание газа по-прежнему оставляет длинный накат.";
  }
  return result;
}
