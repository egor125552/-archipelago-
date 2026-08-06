"use strict";

import * as base from "./free-roam-replication.js";
import {isDualTurretBoat} from "./free-roam-dual-turret-boat.js";

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
    if (!source || !target || !isDualTurretBoat(source)) continue;
    target.boatType = source.boatType;
    target.label = source.label;
    target.structuralHull = rounded(source.structuralHull);
    target.maxStructuralHull = rounded(source.maxStructuralHull);
    target.crew = [...(source.crew || [])];
    target.turrets = (source.turrets || []).map(turret => ({
      id: turret.id,
      label: turret.label,
      playerIndex: turret.playerIndex,
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
  const projectiles = world?.freeDualTurretProjectiles;
  if (projectiles) {
    snapshot.freeDualTurretProjectiles = {
      // Stable-ID maps remain delta-compatible even when this field first
      // appears in a world previously rendered by the older client. Empty
      // arrays would be reconstructed as objects by the legacy delta reader.
      projectiles: Object.fromEntries((projectiles.projectiles || []).map(projectile => [projectile.id, {
        id: projectile.id,
        turretId: projectile.turretId,
        sourcePlayer: projectile.sourcePlayer,
        sourceBoatId: projectile.sourceBoatId,
        targetId: projectile.targetId,
        x: rounded(projectile.x),
        y: rounded(projectile.y),
        previousX: rounded(projectile.previousX),
        previousY: rounded(projectile.previousY),
        vx: rounded(projectile.vx),
        vy: rounded(projectile.vy),
        launchHeading: rounded(projectile.launchHeading),
        inheritedBoatVelocity: {
          x: rounded(projectile.inheritedBoatVelocity?.x),
          y: rounded(projectile.inheritedBoatVelocity?.y),
        },
        age: rounded(projectile.age),
        ttl: rounded(projectile.ttl),
      }])),
      endEvents: Object.fromEntries((projectiles.endEvents || []).slice(-16).map((event, index) => [
        `${event.id || "dual-shot"}:${rounded(event.at)}:${event.reason || "end"}:${index}`,
        event,
      ])),
    };
  }
  return snapshot;
}
