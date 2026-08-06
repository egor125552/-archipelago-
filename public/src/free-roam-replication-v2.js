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
    target.controlProfile = source.controlProfile || "player-boat";
    target.speechProfile = source.speechProfile || "standard";
    target.audioProfile = source.audioProfile || "standard";
    target.engineSound = source.engineSound || "motorboatReal";
    target.mountedWeaponId = source.mountedWeaponId || null;
    if (!isDualTurretBoat(source)) continue;
    target.structuralHull = rounded(source.structuralHull);
    target.maxStructuralHull = rounded(source.maxStructuralHull);
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
  const purchase = world?.freeDualTurretPurchase;
  if (purchase) {
    snapshot.freeDualTurretPurchase = {
      purchased: Boolean(purchase.purchased),
      price: Math.max(0, Math.floor(Number(purchase.price) || 0)),
      purchasedBy: Number.isInteger(purchase.purchasedBy) ? purchase.purchasedBy : null,
      purchasedAt: rounded(purchase.purchasedAt),
    };
  }
  if (world?.freeDualTurretProjectiles) {
    snapshot.freeDualTurretProjectiles = {mode: "instant"};
  }
  return snapshot;
}
