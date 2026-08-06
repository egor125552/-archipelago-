"use strict";

export const DUAL_TURRET_BOAT_TYPE = "dual-turret-patrol";
export const DUAL_TURRET_BOAT_ID = 2;
export const DUAL_TURRET_HULL_POINTS = 300;
export const DUAL_TURRET_ARMOR_POINTS = 200;
export const DUAL_TURRET_MAX_SPEED = 13.5;
export const DUAL_TURRET_REVERSE_SPEED = 4.8;
export const DUAL_TURRET_ACCELERATION_FACTOR = 0.86;
export const DUAL_TURRET_TURN_FACTOR = 1.28;
export const DUAL_TURRET_BOARDING_RANGE = 22;
export const DUAL_TURRET_COLLISION_RADIUS = 7.5;
export const DUAL_TURRET_WEAPON_ID = "dual-turret";
export const DUAL_TURRET_SHOT_DAMAGE = 18;
export const DUAL_TURRET_SHOT_INTERVAL = 0.72;
export const DUAL_TURRET_PROJECTILE_SPEED = 96;
export const DUAL_TURRET_PROJECTILE_TTL = 3.2;
export const DUAL_TURRET_START_AMMO = 1000;
export const DUAL_TURRET_PRICE = 0;
export const DUAL_TURRET_RECOVERY_SECONDS = 60;
export const DUAL_TURRET_AUDIO_ROOT = "/assets/audio/free-roam-dual-turret/";

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
