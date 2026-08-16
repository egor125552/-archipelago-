"use strict";

import {createSpatialModuleRegistry} from "../../spatial/spatial-compiler.js";
import {SpatialWorld} from "../../spatial/spatial-world.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "../../spatial/spatial-standard-modules.js";

const rectangle = (width, height, maxZ = 3) => ({
  outer: [[0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]],
  minZ: 0,
  maxZ,
});

export const SPATIAL_LAB_LOCATION = Object.freeze({
  schemaVersion: 1,
  id: "location.spatial.lab",
  label: "Пространственная лаборатория",
  presentation: {
    label: "Пространственная лаборатория",
    description: "Маленькая тестовая локация новой пространственной архитектуры",
    role: "location",
  },
  worldTransform: {position: {x: 272, y: 14, z: 2}, yaw: 0},
  persistence: {version: 1},
  spaces: [
    {
      id: "lab.yard",
      label: "Испытательный двор",
      presentation: {label: "Испытательный двор", description: "Открытая площадка на нижнем уровне", role: "outdoor"},
      transform: {position: {x: 0, y: 0, z: 0}, yaw: 0},
      shape: rectangle(20, 20, 3),
      acoustics: {profile: "open", gain: 1, lowpassHz: 20000, reverb: 0.06},
      activity: {activeRadius: 28, preloadRadius: 45},
      anchors: [
        {id: "lab.anchor.entry", kind: "spawn", label: "Вход во двор", position: [2, 2, 0]},
        {id: "lab.anchor.stairs.bottom", kind: "transition", label: "Нижняя площадка лестницы", position: [15, 4, 0]},
        {id: "lab.anchor.lift.bottom", kind: "transition", label: "Лифт на нижнем уровне", position: [6, 6, 0]},
      ],
      objects: [
        {id: "lab.object.beacon", kind: "beacon", label: "Звуковой маяк", position: [9, 9, 0]},
      ],
    },
    {
      id: "lab.upper.room",
      label: "Верхняя комната",
      presentation: {label: "Верхняя комната", description: "Закрытое помещение на высоте четырёх метров", role: "indoor"},
      transform: {position: {x: 12, y: 4, z: 4}, yaw: 0},
      shape: rectangle(8, 8, 3),
      acoustics: {profile: "small.room", gain: 0.96, lowpassHz: 15500, reverb: 0.42},
      activity: {activeRadius: 24, preloadRadius: 40},
      anchors: [
        {id: "lab.anchor.stairs.top", kind: "transition", label: "Верхняя площадка лестницы", position: [1, 1, 0]},
        {id: "lab.anchor.lift.top", kind: "transition", label: "Дверь лифта наверху", position: [3, 2, 0]},
        {id: "lab.anchor.upper.safe", kind: "spawn", label: "Безопасная точка верхней комнаты", position: [4, 4, 0]},
      ],
      objects: [
        {id: "lab.object.generator", kind: "generator", label: "Тестовый генератор", position: [6, 5, 0]},
      ],
    },
    {
      id: "lab.lift",
      label: "Кабина лифта",
      presentation: {label: "Кабина лифта", description: "Вложенное движущееся пространство", role: "vehicle"},
      parentSpaceId: "lab.yard",
      moving: true,
      transform: {position: {x: 5, y: 5, z: 0}, yaw: 0},
      shape: rectangle(3, 3, 2.5),
      acoustics: {profile: "metal.cabin", gain: 0.9, lowpassHz: 11000, reverb: 0.3},
      activity: {activeRadius: 16, preloadRadius: 24},
      anchors: [
        {id: "lab.anchor.lift.center", kind: "safe", label: "Центр кабины", position: [1.5, 1.5, 0]},
      ],
      objects: [
        {id: "lab.object.lift.panel", kind: "control", label: "Панель лифта", position: [0.5, 1.5, 0]},
      ],
    },
    {
      id: "lab.remote.store",
      label: "Удалённый склад",
      presentation: {label: "Удалённый склад", description: "Удалённая область для проверки сна и сетевого интереса", role: "indoor"},
      transform: {position: {x: 90, y: 0, z: 0}, yaw: 0},
      shape: rectangle(6, 6, 3),
      acoustics: {profile: "store", gain: 0.92, lowpassHz: 12500, reverb: 0.5},
      activity: {activeRadius: 18, preloadRadius: 30},
      anchors: [
        {id: "lab.anchor.store.entry", kind: "transition", label: "Вход на удалённый склад", position: [1, 1, 0]},
        {id: "lab.anchor.store.safe", kind: "spawn", label: "Безопасная точка склада", position: [3, 3, 0]},
      ],
      objects: [
        {id: "lab.object.crate", kind: "crate", label: "Контрольный ящик", position: [4, 4, 0]},
      ],
    },
  ],
  connections: [
    {
      id: "lab.connection.stairs",
      label: "Лестница наверх",
      presentation: {label: "Лестница наверх", description: "Переход между нижним и верхним уровнями", role: "transition"},
      kind: "stairs",
      from: {spaceId: "lab.yard", position: [15, 4, 0], fallbackAnchorId: "lab.anchor.stairs.bottom"},
      to: {spaceId: "lab.upper.room", position: [1, 1, 0], fallbackAnchorId: "lab.anchor.stairs.top"},
      initialState: "open",
      traversal: {mode: "timed", duration: 1.4},
      cost: 2,
      acousticTransmission: {open: 0.82, closed: 0.12},
    },
    {
      id: "lab.connection.lift.board",
      label: "Войти в лифт",
      presentation: {label: "Войти в лифт", description: "Дверь кабины на нижнем уровне", role: "transition"},
      kind: "lift",
      from: {spaceId: "lab.yard", position: [6, 6, 0], fallbackAnchorId: "lab.anchor.lift.bottom"},
      to: {spaceId: "lab.lift", position: [1.5, 1.5, 0], fallbackAnchorId: "lab.anchor.lift.center"},
      initialState: "open",
      traversal: {mode: "instant"},
      cost: 1,
      acousticTransmission: {open: 0.9, closed: 0.08},
    },
    {
      id: "lab.connection.lift.exit",
      label: "Выйти из лифта наверху",
      presentation: {label: "Выйти из лифта наверху", description: "Дверь между кабиной и верхней комнатой", role: "transition"},
      kind: "lift",
      from: {spaceId: "lab.lift", position: [1.5, 1.5, 0], fallbackAnchorId: "lab.anchor.lift.center"},
      to: {spaceId: "lab.upper.room", position: [3, 2, 0], fallbackAnchorId: "lab.anchor.lift.top"},
      initialState: "closed",
      traversal: {mode: "instant"},
      cost: 1,
      acousticTransmission: {open: 0.9, closed: 0.06},
    },
    {
      id: "lab.connection.store",
      label: "Служебный переход к складу",
      presentation: {label: "Служебный переход к складу", description: "Переход в удалённую область", role: "transition"},
      kind: "door",
      from: {spaceId: "lab.upper.room", position: [7, 6, 0], fallbackAnchorId: "lab.anchor.upper.safe"},
      to: {spaceId: "lab.remote.store", position: [1, 1, 0], fallbackAnchorId: "lab.anchor.store.entry"},
      initialState: "open",
      traversal: {mode: "timed", duration: 0.8},
      cost: 4,
      acousticTransmission: {open: 0.7, closed: 0.04},
    },
  ],
  spawns: [
    {id: "lab.spawn.entry", spaceId: "lab.yard", anchorId: "lab.anchor.entry", mode: "foot"},
    {id: "lab.spawn.upper", spaceId: "lab.upper.room", anchorId: "lab.anchor.upper.safe", mode: "foot"},
    {id: "lab.spawn.store", spaceId: "lab.remote.store", anchorId: "lab.anchor.store.safe", mode: "foot"},
  ],
  modules: [
    {id: "lab.navigation", type: "spatial.navigation", config: {}},
    {id: "lab.acoustics", type: "spatial.acoustics", config: {}},
    {id: "lab.accessibility", type: "spatial.accessibility", config: {}},
    {id: "lab.lifecycle", type: "spatial.lifecycle", config: {}},
    {id: "lab.replication", type: "spatial.replication", config: {}},
    {id: "lab.persistence", type: "spatial.persistence", config: {}},
  ],
});

export function createSpatialLab({extraModuleTypes = [], definition = SPATIAL_LAB_LOCATION, mode = "development", clock} = {}) {
  const registry = createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, ...extraModuleTypes]);
  const world = new SpatialWorld({moduleRegistry: registry, mode, clock});
  const runtime = world.addLocation(definition);
  return Object.freeze({world, registry, compiled: runtime.location, runtime});
}
