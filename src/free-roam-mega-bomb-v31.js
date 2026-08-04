"use strict";

import * as base from "./free-roam-mega-bomb-v30.js";

export * from "./free-roam-mega-bomb-v30.js";

export function clearLegacyImpactAcousticsV31(world) {
  if (!world?.freeMegaBombAcoustics) return false;
  const state = world.freeMegaBombAcoustics;
  if (Array.isArray(state.impacts)) state.impacts.length = 0;
  if (Array.isArray(state.seen)) state.seen.length = 0;
  delete world.freeMegaBombAcoustics;
  return true;
}

export function stepMegaBombs(world, dt) {
  base.stepMegaBombs(world, dt);
  clearLegacyImpactAcousticsV31(world);
}
