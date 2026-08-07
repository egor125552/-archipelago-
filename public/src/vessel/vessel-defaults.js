"use strict";

export const STANDARD_BOAT_RUNTIME_DEFAULTS = Object.freeze({
  crewCapacity: 1,
  collisionRadius: 6,
  cargoCapacity: 5,
  audioProfile: "standard",
  speed: 0,
  throttle: 0,
  rudder: 0,
  hull: 100,
  hullMax: 100,
  armor: 0,
  armorMax: 0,
  water: 0,
  leak: 0,
  fuel: 100,
  engineTemp: 24,
  engineStalled: false,
  pumpActive: false,
  repairPatches: 3,
  hullRepairProgress: 0,
  repairQuarter: 0,
  emergencyActive: false,
  emergencyRemaining: 45,
  emergencyWarned15: false,
  emergencyWarned5: false,
  restartProgress: 0,
  sunk: false,
  collisionCooldown: 0,
});

export const STANDARD_BOAT_PRESET = Object.freeze({
  id: "standard-boat",
  capabilities: Object.freeze({
    boardable: true,
    exitable: true,
    collidable: true,
    damageable: true,
    replicates: true,
    sonarTarget: true,
    towable: true,
  }),
  physics: Object.freeze({mode: "profile", profile: "standard"}),
  runtimeDefaults: STANDARD_BOAT_RUNTIME_DEFAULTS,
  modules: Object.freeze([]),
});

export const LEGACY_BOAT_PRESET = Object.freeze({
  id: "legacy-existing-boat",
  capabilities: Object.freeze({
    boardable: true,
    exitable: true,
    collidable: true,
    damageable: true,
    replicates: true,
    sonarTarget: true,
    towable: true,
  }),
  physics: Object.freeze({mode: "legacy-object"}),
  modules: Object.freeze([]),
});
