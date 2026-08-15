"use strict";

import {activeHeavyPursuer, ensureHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js?v=4";
import {ensureThreatDirector, notifyThreatBoatDestroyed} from "../public/src/free-roam-threat-director.js?v=4";

function levelFiveContractStillActive(world, state) {
  const contracts = world?.freeContracts;
  return Boolean(
    state?.active
    || (
      contracts?.encounterActive === true
      && Math.max(Number(contracts?.encounterLevel) || 0, Number(state?.level) || 0) >= 5
    )
  );
}

export function recoverOrphanedHeavyPhase(world) {
  if (!world) return false;
  const state = ensureThreatDirector(world);
  if (Number(state.level) < 5 || !state.heavyStarted || state.eliteBossStarted) return false;
  if (!levelFiveContractStillActive(world, state)) return false;
  if (activeHeavyPursuer(world)) return false;

  const heavyState = ensureHeavyPursuer(world);
  const heavy = heavyState?.boat;
  if (
    !heavy
    || String(heavy.id || "") !== "heavy-pursuer"
    || heavy.destroyed !== true
    || Number(heavy.hull) > 0
  ) return false;

  // The destruction callback is a notification, not the source of truth.
  // If any weapon path misses it, authoritative world state repairs the phase.
  state.active = true;
  state.lastPoint = {x: Number(heavy.x) || 210, y: Number(heavy.y) || 180};
  notifyThreatBoatDestroyed(world, heavy, -1);

  if (!state.eliteBossStarted) return false;
  world.events ||= [];
  world.events.push({
    type: "contract-threat-phase-recovered",
    text: "",
    targets: [],
    at: world.time,
    operationEvent: true,
    level: state.level,
    phase: 3,
    heavyId: heavy.id,
    x: heavy.x,
    y: heavy.y,
  });
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
  return true;
}
