"use strict";

import {STANDARD_BOAT_RUNTIME_DEFAULTS} from "../vessel-defaults.js";

const COMMON_RUNTIME_FIELDS = Object.freeze([
  "x", "y", "heading", "speed", "throttle", "rudder", "owner", "driver", "crew", "crewCapacity",
  "hull", "hullMax", "armor", "armorMax", "water", "leak", "fuel", "engineTemp", "engineStalled",
  "pumpActive", "repairPatches", "hullRepairProgress", "repairQuarter", "emergencyActive", "emergencyRemaining",
  "restartProgress", "sunk", "reserved", "collisionCooldown", "cargo", "cargoCapacity",
]);

export const CURRENT_VESSEL_TYPES = Object.freeze([
  Object.freeze({
    id: "standard",
    preset: "standard-boat",
    label: "катер",
    runtimeStateFields: COMMON_RUNTIME_FIELDS,
    modules: [
      {id: "engine", type: "propulsion"},
      {id: "helm", type: "steering"},
      {id: "bilge-pump", type: "pump"},
      {id: "repair", type: "repair-station"},
      {id: "fuel", type: "fuel-tank"},
      {id: "cargo", type: "cargo-hold"},
      {id: "sonar", type: "sonar"},
    ],
    damage: {mode: "global"},
  }),
  Object.freeze({
    id: "dual-turret-patrol",
    preset: "standard-boat",
    label: "двухместный бронекатер",
    capabilities: {towable: false, sonarTarget: true, zonalDamage: false},
    physics: {mode: "profile", profile: "dual-turret-heavy-v1"},
    runtimeDefaults: {
      ...STANDARD_BOAT_RUNTIME_DEFAULTS,
      crewCapacity: 2,
      collisionRadius: 7.5,
      boardingRange: 22,
      hull: 300,
      hullMax: 300,
      armor: 200,
      armorMax: 200,
      audioProfile: "dual-turret-heavy",
    },
    runtimeStateFields: Object.freeze([...COMMON_RUNTIME_FIELDS, "turrets", "boardingRange", "audioProfile"]),
    mounts: [
      {id: "port-weapon-hardpoint", kind: "weapon-hardpoint", accepts: ["mounted-weapon"]},
      {id: "starboard-weapon-hardpoint", kind: "weapon-hardpoint", accepts: ["mounted-weapon"]},
    ],
    modules: [
      {id: "engine", type: "propulsion"},
      {id: "helm", type: "steering"},
      {id: "bilge-pump", type: "pump"},
      {id: "repair", type: "repair-station"},
      {id: "fuel", type: "fuel-tank"},
      {id: "cargo", type: "cargo-hold"},
      {id: "sonar", type: "sonar"},
      {id: "port-turret", type: "mounted-weapon", mounts: ["port-weapon-hardpoint"], config: {ammo: 1000}},
      {id: "starboard-turret", type: "mounted-weapon", mounts: ["starboard-weapon-hardpoint"], config: {ammo: 1000}},
    ],
    damage: {mode: "global"},
  }),
]);

export function installCurrentVesselTypes(registry) {
  for (const definition of CURRENT_VESSEL_TYPES) registry.registerVesselType(definition);
}
