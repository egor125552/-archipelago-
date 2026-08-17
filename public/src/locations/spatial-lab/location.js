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
    description: "Маленькая тестовая локация общей пространственной архитектуры",
    role: "location",
  },
  worldTransform: {position: {x: 120, y: 80, z: 2}, yaw: 15},
  persistence: {version: 1},
  spaces: [
    {
      id: "lab.yard",
      label: "Испытательный двор",
      presentation: {label: "Испытательный двор", description: "Открытая площадка на нижнем уровне", role: "outdoor"},
      transform: {position: {x: 0, y: 0, z: 0}, yaw: 0},
      // The tall vertical envelope is intentional. A falling entity is moved
      // into the lower support space while it is still physically above it;
      // the existing free-roam gravity then reduces its vertical offset.
      shape: rectangle(20, 20, 20),
      acoustics: {profile: "open", gain: 1, lowpassHz: 20000, reverb: 0.06},
      activity: {activeRadius: 28, preloadRadius: 45},
      anchors: [
        {id: "lab.anchor.entry", kind: "spawn", label: "Вход во двор", position: [2, 2, 0]},
        {id: "lab.anchor.stairs.bottom", kind: "transition", label: "Нижняя площадка лестницы", position: [15, 4, 0]},
        {id: "lab.anchor.lift.bottom", kind: "transition", label: "Лифт на нижнем уровне", position: [6, 6, 0]},
        {id: "lab.anchor.basin", kind: "transition", label: "Проход к водяному бассейну", position: [2, 13, 0]},
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
        {id: "lab.anchor.high.bottom", kind: "transition", label: "Лестница на высокую площадку", position: [2, 2, 0]},
        {id: "lab.anchor.upper.edge", kind: "hazard", label: "Край четырёхметрового обрыва", position: [4, 7.4, 0]},
      ],
      objects: [
        {id: "lab.object.generator", kind: "generator", label: "Тестовый генератор", position: [6, 5, 0]},
        {id: "lab.object.store-barrier", kind: "barrier", label: "Служебная металлическая перегородка", position: [5, 5, 0]},
      ],
    },
    {
      id: "lab.high.platform",
      label: "Высокая площадка",
      presentation: {label: "Высокая площадка", description: "Открытая испытательная площадка на высоте двенадцати метров", role: "outdoor"},
      transform: {position: {x: 12, y: 4, z: 12}, yaw: 0},
      shape: rectangle(8, 8, 3),
      acoustics: {profile: "open", gain: 1, lowpassHz: 20000, reverb: 0.08},
      activity: {activeRadius: 28, preloadRadius: 45},
      anchors: [
        {id: "lab.anchor.high.top", kind: "transition", label: "Верх лестницы", position: [2, 2, 0]},
        {id: "lab.anchor.high.edge", kind: "hazard", label: "Край двенадцатиметрового обрыва", position: [4, 7.4, 0]},
      ],
      objects: [],
    },
    {
      id: "lab.water.basin",
      label: "Водяной бассейн",
      presentation: {label: "Водяной бассейн", description: "Отдельный объём для проверки воды, источников и насоса", role: "indoor"},
      transform: {position: {x: 1, y: 12, z: 0}, yaw: 0},
      shape: rectangle(6, 6, 3),
      acoustics: {profile: "small.room", gain: 0.9, lowpassHz: 13500, reverb: 0.3},
      activity: {activeRadius: 20, preloadRadius: 32},
      anchors: [
        {id: "lab.anchor.basin.entry", kind: "transition", label: "Вход в бассейн", position: [1, 1, 0]},
      ],
      objects: [
        {id: "lab.object.water-pump", kind: "control", label: "Насос бассейна", position: [4.5, 1.5, 0]},
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
      id: "lab.connection.high.ladder",
      label: "Лестница на высокую площадку",
      presentation: {label: "Лестница на высокую площадку", description: "Подъём с четырёхметрового уровня на двенадцатиметровый", role: "transition"},
      kind: "ladder",
      from: {spaceId: "lab.upper.room", position: [2, 2, 0], fallbackAnchorId: "lab.anchor.high.bottom"},
      to: {spaceId: "lab.high.platform", position: [2, 2, 0], fallbackAnchorId: "lab.anchor.high.top"},
      initialState: "open",
      traversal: {mode: "timed", duration: 2.2},
      cost: 3,
      acousticTransmission: {open: 0.9, closed: 0.16},
    },
    {
      id: "lab.connection.basin",
      label: "Проход к водяному бассейну",
      presentation: {label: "Проход к водяному бассейну", description: "Переход в отдельный водяной тестовый объём", role: "transition"},
      kind: "passage",
      from: {spaceId: "lab.yard", position: [2, 13, 0], fallbackAnchorId: "lab.anchor.basin"},
      to: {spaceId: "lab.water.basin", position: [1, 1, 0], fallbackAnchorId: "lab.anchor.basin.entry"},
      initialState: "open",
      traversal: {mode: "instant"},
      cost: 1,
      acousticTransmission: {open: 0.88, closed: 0.12},
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
      presentation: {label: "Служебный переход к складу", description: "Разрушаемая перегородка перед удалённой областью", role: "transition"},
      // This is deliberately not a normal door: the generic action handler may
      // open doors. The acceptance barrier must stay blocked until the shared
      // destruction module changes this same connection to "destroyed".
      kind: "custom",
      from: {spaceId: "lab.upper.room", position: [7, 6, 0], fallbackAnchorId: "lab.anchor.upper.safe"},
      to: {spaceId: "lab.remote.store", position: [1, 1, 0], fallbackAnchorId: "lab.anchor.store.entry"},
      initialState: "blocked",
      traversal: {mode: "timed", duration: 0.8},
      cost: 4,
      acousticTransmission: {open: 0.7, closed: 0.04},
    },
  ],
  spawns: [
    {id: "lab.spawn.entry", spaceId: "lab.yard", anchorId: "lab.anchor.entry", mode: "foot"},
    {id: "lab.spawn.upper", spaceId: "lab.upper.room", anchorId: "lab.anchor.upper.safe", mode: "foot"},
    {id: "lab.spawn.high", spaceId: "lab.high.platform", anchorId: "lab.anchor.high.top", mode: "foot"},
    {id: "lab.spawn.store", spaceId: "lab.remote.store", anchorId: "lab.anchor.store.safe", mode: "foot"},
  ],
  modules: [
    {id: "lab.navigation", type: "spatial.navigation", config: {}},
    {id: "lab.acoustics", type: "spatial.acoustics", config: {}},
    {id: "lab.accessibility", type: "spatial.accessibility", config: {}},
    {id: "lab.lifecycle", type: "spatial.lifecycle", config: {}},
    {id: "lab.replication", type: "spatial.replication", config: {}},
    {id: "lab.persistence", type: "spatial.persistence", config: {}},
    {
      id: "lab.materials",
      type: "spatial.materials",
      config: {
        defaultMaterial: "concrete",
        assignments: {
          spaces: {
            "lab.yard": "concrete",
            "lab.upper.room": "metal",
            "lab.high.platform": "metal",
            "lab.water.basin": "concrete",
            "lab.lift": "metal",
            "lab.remote.store": "concrete",
          },
          connections: {
            "lab.connection.high.ladder": "metal",
            "lab.connection.store": "metal",
          },
        },
      },
    },
    {
      id: "lab.water",
      type: "spatial.water",
      config: {
        volumes: [
          {id: "lab.water.volume.basin", spaceId: "lab.water.basin", area: 36, maxDepth: 2.5, initialDepth: 1.4, materialId: "water"},
        ],
        sources: [
          {id: "lab.water.source", volumeId: "lab.water.volume.basin", rate: 0.7, enabled: false},
        ],
        pumps: [
          {id: "lab.water.pump", volumeId: "lab.water.volume.basin", rate: 1.0, enabled: false},
        ],
      },
    },
    {
      id: "lab.destruction",
      type: "spatial.destruction",
      config: {
        targets: [
          {id: "lab.destructible.store-door", label: "Служебная металлическая перегородка", maxHealth: 60, materialId: "metal", connectionId: "lab.connection.store", blocksMovement: true, blocksSight: true, blocksSound: true},
        ],
      },
    },
    {
      id: "lab.actors",
      type: "spatial.actors",
      config: {
        actors: [
          {id: "lab.actor.dummy", label: "Испытательный манекен", spaceId: "lab.yard", position: [11, 11, 0], maxHealth: 80, hostile: false, kind: "dummy"},
        ],
      },
    },
    {
      id: "lab.combat",
      type: "spatial.combat",
      config: {
        barriers: [
          {id: "lab.barrier.store-door", spaceId: "lab.upper.room", center: [5.7, 5.5, 1], radius: 0.8, destructibleId: "lab.destructible.store-door"},
        ],
      },
    },
    {
      id: "lab.items",
      type: "spatial.items",
      config: {
        items: [
          {id: "lab.item.battery", label: "Тестовая батарея", kind: "battery", spaceId: "lab.yard", position: [7, 10, 0]},
        ],
      },
    },
    {
      id: "lab.quests",
      type: "spatial.quests",
      config: {
        quests: [
          {
            id: "lab.quest.acceptance",
            label: "Приёмка пространственного фундамента",
            autoStart: true,
            objectives: [
              {id: "break-door", eventKind: "destruction.destroyed", match: {targetId: "lab.destructible.store-door"}},
              {id: "defeat-dummy", eventKind: "actor.death", match: {actorId: "lab.actor.dummy"}},
            ],
          },
        ],
      },
    },
    {
      id: "lab.fall",
      type: "spatial.fall",
      config: {
        drops: [
          {id: "lab.drop.upper", label: "четырёхметрового обрыва", fromSpaceId: "lab.upper.room", toSpaceId: "lab.yard", edge: {axis: "y", side: "max", rangeMin: 1, rangeMax: 7, approach: 1.7}, materialId: "concrete"},
          {id: "lab.drop.high", label: "двенадцатиметрового обрыва", fromSpaceId: "lab.high.platform", toSpaceId: "lab.yard", edge: {axis: "y", side: "max", rangeMin: 1, rangeMax: 7, approach: 1.7}, materialId: "concrete"},
        ],
      },
    },
  ],
});

export function createSpatialLab({extraModuleTypes = [], definition = SPATIAL_LAB_LOCATION, mode = "development", clock} = {}) {
  const registry = createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, ...extraModuleTypes]);
  const world = new SpatialWorld({moduleRegistry: registry, mode, clock});
  const runtime = world.addLocation(definition);
  return Object.freeze({world, registry, compiled: runtime.location, runtime});
}
