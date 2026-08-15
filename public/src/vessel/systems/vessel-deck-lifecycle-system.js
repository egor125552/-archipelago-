"use strict";

import {clearVesselOccupantPosition} from "../vessel-interior.js";
import {releaseVesselOccupantResources} from "../vessel-deck-runtime.js";

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 280) world.events.splice(0, world.events.length - 280);
}

function releaseOrphanedClaims({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (!entry?.definition?.deckArchitecture?.enabled) continue;
    const occupants = entry.instance?.occupants || {};
    const owners = new Set(Object.values(entry.instance?.interior?.claims || {}).filter(Number.isInteger));
    for (const owner of owners) {
      if (!occupants[owner]) releaseVesselOccupantResources(entry.instance, owner);
    }
  }
}

function releaseSunkCrew({world, nativeVessels} = {}) {
  if (!world) return;
  for (const entry of nativeVessels || []) {
    const boat = entry?.boat;
    if (!boat) continue;
    if (!boat.sunk) {
      delete boat.vesselManualRecoveryNoticeSent;
      continue;
    }
    if (entry?.definition?.deckArchitecture?.enabled !== true) continue;

    const playerIndices = new Set();
    for (const raw of Object.keys(entry.instance?.occupants || {})) {
      const playerIndex = Number(raw);
      if (Number.isInteger(playerIndex)) playerIndices.add(playerIndex);
    }
    for (const playerIndex of boat.crew || []) if (Number.isInteger(playerIndex)) playerIndices.add(playerIndex);
    if (Number.isInteger(boat.driver)) playerIndices.add(boat.driver);

    for (const playerIndex of playerIndices) {
      const player = world.players?.[playerIndex];
      const wasAboard = player?.activeBoat === boat.id || Boolean(entry.instance?.occupants?.[playerIndex]);
      clearVesselOccupantPosition(entry.instance, playerIndex);
      if (!player || !wasAboard) continue;
      player.activeBoat = null;
      player.vesselDeckInputOwned = false;
      player.running = false;
      player.x = Number(boat.x) || 0;
      player.y = Number(boat.y) || 0;
      player.heading = Number(boat.heading) || 0;
      if (player.combat?.alive !== false && player.mode !== "dead") {
        player.mode = "swim";
        emit(world, "vessel-sunk-evacuated", `${boat.label || "Судно"} затонуло. Ты оказался в воде.`, [playerIndex], {
          sourcePlayer: playerIndex,
          boatId: boat.id,
          boatType: boat.boatType || boat.vesselType || null,
          x: player.x,
          y: player.y,
        });
      }
    }

    boat.driver = null;
    boat.throttle = 0;
    boat.rudder = 0;
    boat.speed = 0;
    if (Array.isArray(boat.crew)) boat.crew.fill(null);
    for (const turret of boat.turrets || []) {
      if (turret) turret.assignedPlayer = null;
    }

    if (boat.manualRecoveryOnly === true && boat.vesselManualRecoveryNoticeSent !== true) {
      boat.vesselManualRecoveryNoticeSent = true;
      emit(world, "vessel-manual-recovery-required", `${boat.label || "Судно"} остаётся затонувшим. Для восстановления используй аварийный подъём у торговца.`, [0, 1], {
        boatId: boat.id,
        boatType: boat.boatType || boat.vesselType || null,
        manualRecoveryOnly: true,
        x: boat.x,
        y: boat.y,
      });
    }
  }
}

function maintainDeckLifecycle(context = {}) {
  releaseSunkCrew(context);
  releaseOrphanedClaims(context);
}

export const VESSEL_DECK_LIFECYCLE_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-deck-lifecycle-after-step-v2", phase: "after-step", order: 8, run: maintainDeckLifecycle}),
]);
