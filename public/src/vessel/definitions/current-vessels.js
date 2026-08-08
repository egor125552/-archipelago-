"use strict";

import {STANDARD_BOAT_RUNTIME_DEFAULTS} from "../vessel-defaults.js";
import {
  STRESS_TEST_AUDIO_PROFILE,
  STRESS_TEST_ENGINE_COUNT,
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE,
} from "../stress-test-vessel-config.js?v=1";

const COMMON_RUNTIME_FIELDS = Object.freeze([
  "x", "y", "heading", "speed", "throttle", "rudder", "owner", "driver", "crew", "crewCapacity",
  "hull", "hullMax", "armor", "armorMax", "water", "leak", "fuel", "engineTemp", "engineStalled",
  "pumpActive", "repairPatches", "hullRepairProgress", "repairQuarter", "emergencyActive", "emergencyRemaining",
  "restartProgress", "sunk", "reserved", "collisionCooldown", "cargo", "cargoCapacity",
]);

const STRESS_ENGINE_MODULES = Object.freeze(Array.from({length: STRESS_TEST_ENGINE_COUNT}, (_, index) => Object.freeze({
  id: `engine-${String(index + 1).padStart(2, "0")}`,
  type: "propulsion",
})));

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
  Object.freeze({
    id: STRESS_TEST_VESSEL_TYPE,
    preset: "standard-boat",
    label: "испытательный катер «Пятьдесят»",
    capabilities: {towable: true, sonarTarget: true, zonalDamage: false},
    physics: {mode: "module", module: "stress-50-engine-physics-v1"},
    runtimeDefaults: {
      ...STANDARD_BOAT_RUNTIME_DEFAULTS,
      crewCapacity: 1,
      crew: [],
      collisionRadius: 6.4,
      boardingRange: 18,
      hull: 180,
      hullMax: 180,
      armor: 0,
      armorMax: 0,
      cargoCapacity: 5,
      audioProfile: STRESS_TEST_AUDIO_PROFILE,
      testWeaponAmmo: STRESS_TEST_START_AMMO,
    },
    runtimeStateFields: Object.freeze([...COMMON_RUNTIME_FIELDS, "boardingRange", "audioProfile", "testWeaponAmmo"]),
    mounts: [
      {id: "stress-pistol-hardpoint", kind: "weapon-hardpoint", accepts: ["mounted-weapon"]},
    ],
    modules: [
      ...STRESS_ENGINE_MODULES,
      {id: "helm", type: "steering"},
      {id: "bilge-pump", type: "pump"},
      {id: "repair", type: "repair-station"},
      {id: "fuel", type: "fuel-tank"},
      {id: "cargo", type: "cargo-hold"},
      {id: "sonar", type: "sonar"},
      {
        id: "stress-pistol",
        type: "mounted-weapon",
        mounts: ["stress-pistol-hardpoint"],
        config: {
          inputMode: "driver-attack",
          weaponId: "stress-pistol",
          label: "сверхскоростной пистолет",
          ammo: STRESS_TEST_START_AMMO,
          damage: 12,
          interval: 0.04,
          range: 620,
        },
      },
    ],
    damage: {mode: "global"},
  }),
]);

export function installCurrentVesselTypes(registry) {
  for (const definition of CURRENT_VESSEL_TYPES) registry.registerVesselType(definition);
}
