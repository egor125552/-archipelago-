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

const ARMORED_MAIN_DECK = Object.freeze({
  id: "armored-main-deck",
  label: "малая палуба",
  level: 0,
  presentation: {
    label: "малая палуба",
    forms: {accusative: "малую палубу", prepositional: "малой палубе"},
  },
  shape: {outer: [[-4.2, -5.8], [4.2, -5.8], [4.2, 5.8], [-4.2, 5.8]]},
  movement: {speed: 4.6, jumpDistance: 1.8, runJumpMultiplier: 1.65},
  zones: [
    {
      id: "armored-open-deck",
      label: "открытая палуба",
      presentation: {label: "открытая палуба", forms: {accusative: "открытую палубу", prepositional: "открытой палубе"}},
      shape: {outer: [[-4, -5.6], [4, -5.6], [4, 5.6], [-4, 5.6]]},
      announcement: "first-entry",
    },
  ],
  landmarks: [
    {id: "armored-ladder-landmark", label: "лестница в рубку", position: [0, 3.7], zoneId: "armored-open-deck"},
  ],
  connections: [
    {
      id: "armored-ladder-up",
      kind: "hatch",
      label: "дверь лестничного люка",
      presentation: {label: "дверь лестничного люка", forms: {accusative: "дверь лестничного люка", instrumental: "дверью лестничного люка"}},
      toDeckId: "armored-bridge-deck",
      reverseId: "armored-ladder-down",
      from: [0, 3.7],
      to: [0, -2.9],
      initialState: "closed",
      interactionRange: 1.9,
      traversal: {mode: "geometry", speed: 1.35, levelHeight: 3},
      actionLabel: "подняться по лестнице",
      openText: "Ты открыл дверь лестничного люка.",
      closeText: "Ты закрыл дверь лестничного люка.",
      traverseText: "Ты начинаешь подниматься по лестнице в рубку.",
      arrivalText: "Ты поднялся на верхнюю палубу рубки.",
      autoCloseAfterTraverse: true,
      acoustics: {openTransmission: 0.9, closedTransmission: 0.25},
      water: {watertight: true, flowRate: 8},
    },
  ],
});

const ARMORED_BRIDGE_DECK = Object.freeze({
  id: "armored-bridge-deck",
  label: "верхняя палуба рубки",
  level: 1,
  presentation: {
    label: "верхняя палуба рубки",
    forms: {accusative: "верхнюю палубу рубки", prepositional: "верхней палубе рубки"},
  },
  shape: {outer: [[-2.8, -3.4], [2.8, -3.4], [2.8, 3.4], [-2.8, 3.4]]},
  movement: {speed: 4.2, jumpDistance: 1.65, runJumpMultiplier: 1.6},
  zones: [
    {
      id: "armored-bridge-zone",
      label: "рубка",
      presentation: {label: "рубка", forms: {accusative: "рубку", prepositional: "рубке"}},
      shape: {outer: [[-2.6, -3.2], [2.6, -3.2], [2.6, 3.2], [-2.6, 3.2]]},
      announcement: "zone-change",
    },
  ],
  objects: [
    {
      id: "armored-helm-console",
      kind: "station",
      label: "пульт управления",
      presentation: {label: "пульт управления", forms: {accusative: "пульт управления", genitive: "пульта управления", prepositional: "пульте управления"}},
      position: [0, 1.9],
      zoneId: "armored-bridge-zone",
      resourceId: "armored-helm-control",
      stationRole: "helm",
      controlsVessel: true,
      interactionRange: 1.8,
      occupyLabel: "занять пульт управления",
      leaveLabel: "отойти от пульта",
      occupyText: "Ты занял пульт управления. Теперь бронекатер управляется как обычно.",
      leaveText: "Ты отошёл от пульта управления и снова можешь ходить по палубе.",
    },
  ],
  landmarks: [
    {id: "armored-helm-landmark", label: "пульт управления", position: [0, 1.9], zoneId: "armored-bridge-zone"},
  ],
  connections: [
    {
      id: "armored-ladder-down",
      kind: "hatch",
      label: "дверь лестничного люка",
      presentation: {label: "дверь лестничного люка", forms: {accusative: "дверь лестничного люка", instrumental: "дверью лестничного люка"}},
      toDeckId: "armored-main-deck",
      reverseId: "armored-ladder-up",
      from: [0, -2.9],
      to: [0, 3.7],
      initialState: "closed",
      interactionRange: 1.9,
      traversal: {mode: "geometry", speed: 1.35, levelHeight: 3},
      actionLabel: "спуститься по лестнице",
      openText: "Ты открыл дверь лестничного люка.",
      closeText: "Ты закрыл дверь лестничного люка.",
      traverseText: "Ты начинаешь спускаться по лестнице на малую палубу.",
      arrivalText: "Ты спустился на малую палубу.",
      autoCloseAfterTraverse: true,
      acoustics: {openTransmission: 0.9, closedTransmission: 0.25},
      water: {watertight: true, flowRate: 8},
    },
  ],
});

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
    capabilities: {towable: false, sonarTarget: true, zonalDamage: false, walkableInterior: true},
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
    deckArchitecture: {
      boarding: {
        mode: "deck-entry",
        points: [
          {id: "armored-stern-entry", deckId: "armored-main-deck", position: [0, -4.6], safe: true, enterText: "Ты поднялся на малую палубу бронекатера."},
        ],
      },
      control: {mode: "stations"},
      reconnect: {mode: "last-valid-or-safe"},
      sinking: {mode: "simple", geometryTilt: false},
      playerInertia: {mode: "stable"},
      cargoInertia: {mode: "stable"},
      audio: {footsteps: "default", jump: "default"},
    },
    decks: [ARMORED_MAIN_DECK, ARMORED_BRIDGE_DECK],
    mounts: [
      {id: "port-weapon-hardpoint", kind: "weapon-hardpoint", accepts: ["mounted-weapon"], deckId: "armored-main-deck", position: [-2.5, 1.2]},
      {id: "starboard-weapon-hardpoint", kind: "weapon-hardpoint", accepts: ["mounted-weapon"], deckId: "armored-main-deck", position: [2.5, 1.2]},
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
