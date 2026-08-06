"use strict";

import * as base from "./free-roam-replication.js";
import {isDualTurretBoat} from "./free-roam-dual-turret-boat.js?v=4";

export * from "./free-roam-replication.js";

function rounded(value) {
  const number = Number(value) || 0;
  return Math.round(number * 1_000) / 1_000;
}

export function replicatedFreeWorld(world) {
  const snapshot = base.replicatedFreeWorld(world);
  for (let index = 0; index < (world?.boats || []).length; index += 1) {
    const source = world.boats[index];
    const target = snapshot.boats?.[index];
    if (!source || !target) continue;
    target.boatType = source.boatType || "standard";
    target.label = source.label || "лодка";
    target.crewCapacity = Math.max(1, Math.floor(Number(source.crewCapacity) || 1));
    target.crew = [...(source.crew || [])];
    target.collisionRadius = rounded(source.collisionRadius || 6);
    target.boardingRange = rounded(source.boardingRange || 12);
    target.cargoCapacity = Math.max(1, Math.floor(Number(source.cargoCapacity) || 5));
    target.audioProfile = source.audioProfile || "standard";
    target.hullMax = rounded(source.hullMax || 100);
    if (!isDualTurretBoat(source)) continue;
    target.turrets = (source.turrets || []).map(turret => ({
      id: turret.id,
      label: turret.label,
      playerIndex: turret.playerIndex,
      seatIndex: turret.seatIndex,
      assignedPlayer: turret.assignedPlayer,
      side: turret.side,
      heading: rounded(turret.heading),
      ammo: Math.max(0, Math.floor(Number(turret.ammo) || 0)),
      cooldown: rounded(turret.cooldown),
      minimumRelativeHeading: turret.minimumRelativeHeading,
      maximumRelativeHeading: turret.maximumRelativeHeading,
    }));
  }
  const controller = world?.freeDualTurretBoat;
  if (controller) {
    snapshot.freeDualTurretBoat = {
      version: controller.version,
      boatId: controller.boatId,
      weaponMode: controller.weaponMode || "instant",
      recoveryRemaining: controller.recoveryRemaining == null ? null : rounded(controller.recoveryRemaining),
    };
  }
  return snapshot;
}
