"use strict";

export const MEDIUM_CREW_VESSEL_TYPE = "medium-crew-vessel";
export const MEDIUM_CREW_AUDIO_PROFILE = "medium-crew-v1";
export const MEDIUM_CREW_PENDING_AUDIO_PROFILE = "standard";
export const MEDIUM_CREW_HULL = 220;
export const MEDIUM_CREW_ARMOR = 60;
export const MEDIUM_CREW_START_AMMO = 1000;
export const MEDIUM_CREW_HEAVY_AMMO = 1000;
// Merchant is at (210, 58). y ~= 90 is already used by dock recovery,
// so this places the medium vessel just behind the merchant, in the water.
export const MEDIUM_CREW_SPAWN = Object.freeze({x: 210, y: 92, heading: 0});
export const MEDIUM_CREW_PHYSICS_PROFILE = Object.freeze({
  id: "medium-crew-physics-v1",
  version: 1,
  maxForwardSpeed: 17.2,
  maxReverseSpeed: 5.4,
  accelerationFactor: 0.82,
  turnFactor: 0.78,
  rudderResponseFactor: 0.85,
  dragFactor: 0.9,
});
