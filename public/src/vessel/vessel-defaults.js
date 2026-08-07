"use strict";

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
