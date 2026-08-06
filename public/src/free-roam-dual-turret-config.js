"use strict";

export const DUAL_TURRET_BOAT_TYPE = "dual-turret-patrol";
export const DUAL_TURRET_BOAT_ID = 2;
export const DUAL_TURRET_HULL_POINTS = 300;
export const DUAL_TURRET_ARMOR_POINTS = 200;
export const DUAL_TURRET_MAX_SPEED = 13.5;
export const DUAL_TURRET_REVERSE_SPEED = 4.8;
export const DUAL_TURRET_ACCELERATION_FACTOR = 0.68;
export const DUAL_TURRET_TURN_FACTOR = 0.62;
export const DUAL_TURRET_RUDDER_RESPONSE_FACTOR = 0.72;
export const DUAL_TURRET_DRAG_FACTOR = 0.82;
export const DUAL_TURRET_BOARDING_RANGE = 22;
export const DUAL_TURRET_COLLISION_RADIUS = 7.5;
export const DUAL_TURRET_WEAPON_ID = "dual-turret";
export const DUAL_TURRET_SHOT_DAMAGE = 14;
export const DUAL_TURRET_SHOT_INTERVAL = 0.18;
// Retained for saved-state compatibility. New mounted shots are immediate and
// are never replicated as moving projectile objects.
export const DUAL_TURRET_PROJECTILE_SPEED = 0;
export const DUAL_TURRET_PROJECTILE_TTL = 0;
export const DUAL_TURRET_START_AMMO = 1000;
export const DUAL_TURRET_PRICE = 0;
export const DUAL_TURRET_RECOVERY_SECONDS = 60;
export const DUAL_TURRET_AUDIO_ROOT = "/assets/audio/free-roam-dual-turret/";

export const DUAL_TURRET_PHYSICS_PROFILE = Object.freeze({
  id: "dual-turret-heavy-v1",
  version: 1,
  maxForwardSpeed: DUAL_TURRET_MAX_SPEED,
  maxReverseSpeed: DUAL_TURRET_REVERSE_SPEED,
  accelerationFactor: DUAL_TURRET_ACCELERATION_FACTOR,
  turnFactor: DUAL_TURRET_TURN_FACTOR,
  rudderResponseFactor: DUAL_TURRET_RUDDER_RESPONSE_FACTOR,
  dragFactor: DUAL_TURRET_DRAG_FACTOR,
});

export const DUAL_TURRET_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "dual-turret-port",
    label: "левая установка",
    playerIndex: 0,
    side: -1,
    minimumRelativeHeading: -138,
    maximumRelativeHeading: 38,
  }),
  Object.freeze({
    id: "dual-turret-starboard",
    label: "правая установка",
    playerIndex: 1,
    side: 1,
    minimumRelativeHeading: -38,
    maximumRelativeHeading: 138,
  }),
]);
