"use strict";

import {DUAL_TURRET_PHYSICS_PROFILE} from "./free-roam-dual-turret-config.js?v=4";
import {dualTurretBoat} from "./free-roam-dual-turret-boat.js?v=4";

export function ensureDualTurretPhysicsProfile(world) {
  const boat = dualTurretBoat(world);
  if (!boat) return null;
  if (boat.physicsProfile?.id !== DUAL_TURRET_PHYSICS_PROFILE.id
    || boat.physicsProfile?.version !== DUAL_TURRET_PHYSICS_PROFILE.version) {
    boat.physicsProfile = {...DUAL_TURRET_PHYSICS_PROFILE};
  }
  if (!Number.isFinite(Number(boat.homeX))) boat.homeX = 210;
  if (!Number.isFinite(Number(boat.homeY))) boat.homeY = 102;
  if (!Number.isFinite(Number(boat.homeHeading))) boat.homeHeading = 0;
  if (typeof boat.shopEligible !== "boolean") boat.shopEligible = true;
  return boat;
}
