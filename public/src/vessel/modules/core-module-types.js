"use strict";

function passiveState(enabled = true) {
  return () => ({enabled, health: 100});
}

export const CORE_VESSEL_MODULE_TYPES = Object.freeze([
  Object.freeze({
    id: "propulsion",
    capabilities: ["propulsion"],
    semanticEvents: ["disabled", "restored"],
    presentation: {label: "двигатель", events: {disabled: "{label} выведен из строя.", restored: "{label} снова работает."}},
    createState: passiveState(),
  }),
  Object.freeze({
    id: "steering",
    capabilities: ["steering"],
    semanticEvents: ["disabled", "restored"],
    presentation: {label: "рулевое управление", events: {disabled: "{label} повреждено.", restored: "{label} восстановлено."}},
    createState: passiveState(),
  }),
  Object.freeze({
    id: "pump",
    capabilities: ["pump"],
    semanticEvents: ["started", "stopped"],
    presentation: {label: "помпа", events: {started: "{label} включена.", stopped: "{label} выключена."}},
    createState: () => ({enabled: true, active: false, health: 100}),
  }),
  Object.freeze({
    id: "repair-station",
    capabilities: ["repair"],
    semanticEvents: ["used"],
    presentation: {label: "ремонтный пост", events: {used: "Использован {label}."}},
    createState: passiveState(),
  }),
  Object.freeze({
    id: "fuel-tank",
    userFacing: false,
    capabilities: ["fuel"],
    createState: () => ({enabled: true, health: 100}),
  }),
  Object.freeze({
    id: "cargo-hold",
    userFacing: false,
    capabilities: ["cargo"],
    createState: () => ({enabled: true, health: 100}),
  }),
  Object.freeze({
    id: "sonar",
    capabilities: ["sonar"],
    semanticEvents: ["enabled", "disabled"],
    presentation: {label: "сонар", events: {enabled: "{label} включён.", disabled: "{label} отключён."}},
    createState: passiveState(),
  }),
  Object.freeze({
    id: "mounted-weapon",
    capabilities: ["fire"],
    installation: {mountCount: 1, mountKinds: ["weapon-hardpoint"]},
    semanticEvents: ["station-entered", "fired", "disabled"],
    presentation: {
      label: "корабельная установка",
      roles: {operatorRole: "оператора установки"},
      events: {
        "station-entered": "Ты занял место {operatorRole}.",
        fired: "{label}: выстрел.",
        disabled: "{label} выведена из строя.",
      },
    },
    createState: config => ({enabled: true, health: 100, ammo: Math.max(0, Math.floor(Number(config?.ammo) || 0))}),
  }),
]);

export function installCoreVesselModuleTypes(registry) {
  for (const definition of CORE_VESSEL_MODULE_TYPES) registry.registerModuleType(definition);
}
