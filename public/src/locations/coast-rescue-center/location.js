"use strict";

import {createSpatialModuleRegistry} from "../../spatial/spatial-compiler.js";
import {SpatialWorld} from "../../spatial/spatial-world.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "../../spatial/spatial-standard-modules.js";

const rectangle = (width, height, maxZ = 3) => ({
  outer: [[0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]],
  minZ: 0,
  maxZ,
});

const floorPresentation = (label, description, role = "indoor") => ({label, description, role});
const transitionPresentation = (label, description) => ({label, description, role: "transition"});

export const COAST_RESCUE_CENTER_LOCATION = Object.freeze({
  schemaVersion: 1,
  id: "location.coast.rescue-center",
  label: "Береговой спасательный центр",
  presentation: {
    label: "Береговой спасательный центр",
    description: "Четырёхуровневое служебное здание спасателей за береговой линией",
    role: "location",
  },
  // The existing free-roam walker still owns horizontal movement. Keep the
  // building footprint inside the old shore walking envelope while the shared
  // spatial foundation owns floors and true height.
  worldTransform: {position: {x: 130, y: 12, z: -3}, yaw: 0},
  persistence: {version: 1},
  spaces: [
    {
      id: "rescue.basement",
      label: "Технический подвал",
      presentation: floorPresentation("Технический подвал", "Подземный уровень с генераторной и насосной"),
      transform: {position: {x: 0, y: 0, z: 0}, yaw: 0},
      shape: rectangle(18, 14, 3),
      acoustics: {profile: "concrete.basement", gain: 0.9, lowpassHz: 12500, reverb: 0.48},
      activity: {activeRadius: 26, preloadRadius: 42},
      anchors: [
        {id: "rescue.anchor.basement.safe", kind: "safe", label: "Центр технического подвала", position: [9, 7, 0]},
        {id: "rescue.anchor.basement.stairs", kind: "transition", label: "Лестница на первый этаж", position: [15, 11, 0]},
      ],
      objects: [
        {id: "rescue.object.generator", kind: "generator", label: "Резервный генератор", position: [5, 8, 0]},
        {id: "rescue.object.pump-panel", kind: "control", label: "Панель насосной", position: [12, 8, 0]},
      ],
    },
    {
      id: "rescue.ground",
      label: "Первый этаж, диспетчерская",
      presentation: floorPresentation("Первый этаж, диспетчерская", "Главный вход, диспетчерская и шкаф со спасательным снаряжением"),
      transform: {position: {x: 0, y: 0, z: 3}, yaw: 0},
      shape: rectangle(18, 14, 3.2),
      acoustics: {profile: "office.room", gain: 0.96, lowpassHz: 15800, reverb: 0.34},
      activity: {activeRadius: 28, preloadRadius: 44},
      anchors: [
        {id: "rescue.anchor.entry", kind: "spawn", label: "Главный вход", position: [9, 2, 0]},
        {id: "rescue.anchor.ground.basement", kind: "transition", label: "Лестница в подвал", position: [15, 11, 0]},
        {id: "rescue.anchor.ground.second", kind: "transition", label: "Лестница на второй этаж", position: [3, 11, 0]},
        {id: "rescue.anchor.dispatch", kind: "landmark", label: "Стойка диспетчера", position: [9, 7, 0]},
      ],
      objects: [
        {id: "rescue.object.radio", kind: "radio", label: "Береговая радиостанция", position: [10, 8, 0]},
        {id: "rescue.object.gear-cabinet", kind: "storage", label: "Шкаф спасательного снаряжения", position: [14, 4, 0]},
      ],
    },
    {
      id: "rescue.second",
      label: "Второй этаж, жилой блок",
      presentation: floorPresentation("Второй этаж, жилой блок", "Комната дежурной смены, медпункт и стол с картами"),
      transform: {position: {x: 0, y: 0, z: 7}, yaw: 0},
      shape: rectangle(18, 14, 3.2),
      acoustics: {profile: "office.room", gain: 0.95, lowpassHz: 15000, reverb: 0.38},
      activity: {activeRadius: 28, preloadRadius: 44},
      anchors: [
        {id: "rescue.anchor.second.ground", kind: "transition", label: "Лестница на первый этаж", position: [3, 11, 0]},
        {id: "rescue.anchor.second.roof", kind: "transition", label: "Лестница на крышу", position: [15, 11, 0]},
        {id: "rescue.anchor.medical", kind: "landmark", label: "Медицинский уголок", position: [5, 5, 0]},
      ],
      objects: [
        {id: "rescue.object.map-table", kind: "table", label: "Стол с картой побережья", position: [9, 7, 0]},
        {id: "rescue.object.medical-cabinet", kind: "storage", label: "Медицинский шкаф", position: [5, 6, 0]},
        {id: "rescue.object.bunks", kind: "furniture", label: "Койки дежурной смены", position: [13, 5, 0]},
      ],
    },
    {
      id: "rescue.roof",
      label: "Крыша, наблюдательная площадка",
      presentation: floorPresentation("Крыша, наблюдательная площадка", "Открытая крыша с антенной, прожектором и метеомачтой", "outdoor"),
      transform: {position: {x: 0, y: 0, z: 11}, yaw: 0},
      shape: rectangle(18, 14, 2.5),
      acoustics: {profile: "open", gain: 1, lowpassHz: 20000, reverb: 0.07},
      activity: {activeRadius: 32, preloadRadius: 48},
      anchors: [
        {id: "rescue.anchor.roof.stairs", kind: "transition", label: "Лестница на второй этаж", position: [15, 11, 0]},
        {id: "rescue.anchor.roof.lookout", kind: "landmark", label: "Наблюдательная точка", position: [9, 7, 0]},
      ],
      objects: [
        {id: "rescue.object.antenna", kind: "antenna", label: "Спасательная радиоантенна", position: [4, 7, 0]},
        {id: "rescue.object.searchlight", kind: "light", label: "Поисковый прожектор", position: [9, 12, 0]},
        {id: "rescue.object.weather-mast", kind: "sensor", label: "Метеомачта", position: [14, 7, 0]},
      ],
    },
  ],
  connections: [
    {
      id: "rescue.connection.basement-ground",
      label: "Лестница между подвалом и первым этажом",
      presentation: transitionPresentation("Лестница между подвалом и первым этажом", "Обычная внутренняя лестница между техническим подвалом и диспетчерской"),
      kind: "stairs",
      from: {spaceId: "rescue.basement", position: [15, 11, 0], fallbackAnchorId: "rescue.anchor.basement.stairs"},
      to: {spaceId: "rescue.ground", position: [15, 11, 0], fallbackAnchorId: "rescue.anchor.ground.basement"},
      initialState: "open",
      traversal: {mode: "timed", duration: 1.5, interactionRange: 3.4},
      interactionRange: 3.4,
      discoverRadius: 9,
      cost: 2,
      acousticTransmission: {open: 0.76, closed: 0.12},
    },
    {
      id: "rescue.connection.ground-second",
      label: "Лестница на второй этаж",
      presentation: transitionPresentation("Лестница на второй этаж", "Лестничный пролёт между диспетчерской и жилым блоком"),
      kind: "stairs",
      from: {spaceId: "rescue.ground", position: [3, 11, 0], fallbackAnchorId: "rescue.anchor.ground.second"},
      to: {spaceId: "rescue.second", position: [3, 11, 0], fallbackAnchorId: "rescue.anchor.second.ground"},
      initialState: "open",
      traversal: {mode: "timed", duration: 1.6, interactionRange: 3.4},
      interactionRange: 3.4,
      discoverRadius: 9,
      cost: 2,
      acousticTransmission: {open: 0.74, closed: 0.11},
    },
    {
      id: "rescue.connection.second-roof",
      label: "Лестница на крышу",
      presentation: transitionPresentation("Лестница на крышу", "Лестничный пролёт из жилого блока на наблюдательную крышу"),
      kind: "stairs",
      from: {spaceId: "rescue.second", position: [15, 11, 0], fallbackAnchorId: "rescue.anchor.second.roof"},
      to: {spaceId: "rescue.roof", position: [15, 11, 0], fallbackAnchorId: "rescue.anchor.roof.stairs"},
      initialState: "open",
      traversal: {mode: "timed", duration: 1.8, interactionRange: 3.4},
      interactionRange: 3.4,
      discoverRadius: 9,
      cost: 2,
      acousticTransmission: {open: 0.86, closed: 0.15},
    },
  ],
  spawns: [
    {id: "rescue.spawn.entry", spaceId: "rescue.ground", anchorId: "rescue.anchor.entry", mode: "foot"},
    {id: "rescue.spawn.safe", spaceId: "rescue.ground", anchorId: "rescue.anchor.dispatch", mode: "foot"},
  ],
  modules: [
    {id: "rescue.navigation", type: "spatial.navigation", config: {}},
    {id: "rescue.acoustics", type: "spatial.acoustics", config: {}},
    {id: "rescue.accessibility", type: "spatial.accessibility", config: {}},
    {id: "rescue.lifecycle", type: "spatial.lifecycle", config: {}},
    {id: "rescue.replication", type: "spatial.replication", config: {}},
    {id: "rescue.persistence", type: "spatial.persistence", config: {}},
    {
      id: "rescue.materials",
      type: "spatial.materials",
      config: {
        defaultMaterial: "concrete",
        assignments: {
          spaces: {
            "rescue.basement": "concrete",
            "rescue.ground": "concrete",
            "rescue.second": "concrete",
            "rescue.roof": "concrete",
          },
          connections: {
            "rescue.connection.basement-ground": "metal",
            "rescue.connection.ground-second": "metal",
            "rescue.connection.second-roof": "metal",
          },
        },
      },
    },
  ],
});

export function createCoastRescueCenter({definition = COAST_RESCUE_CENTER_LOCATION, extraModuleTypes = [], mode = "development", clock} = {}) {
  const registry = createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, ...extraModuleTypes]);
  const world = new SpatialWorld({moduleRegistry: registry, mode, clock});
  const runtime = world.addLocation(definition);
  return Object.freeze({world, registry, compiled: runtime.location, runtime});
}
