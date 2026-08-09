"use strict";

import {VesselContractError, cloneData} from "./vessel-contract.js";
import {createVesselRegistry} from "./vessel-registry.js";
import {STANDARD_BOAT_PRESET, LEGACY_BOAT_PRESET} from "./vessel-defaults.js";
import {syncLegacyVesselWorld, legacyVesselViews} from "./vessel-legacy-adapter.js";
import {installVesselContent} from "./vessel-content-manifest.js?v=2";
import {installVesselPlugins} from "./vessel-plugin-manifest.js?v=2";
import {migratePersistedVesselWorld, VESSEL_SAVE_VERSION} from "./vessel-save.js";
import {clearVesselOccupantPosition, setVesselOccupantPosition, syncWalkableVesselOccupants} from "./vessel-interior.js";
import {
  advanceVesselDeckRuntime,
  releaseVesselOccupantResources,
  safeReconnectPosition,
  vesselDeckPersistentState,
} from "./vessel-deck-runtime.js";
import {installVesselModule} from "./vessel-modules.js";
import {vesselNetworkSnapshot} from "./vessel-network.js";
import {vesselOwnsSubsystem} from "./vessel-authority.js?v=1";

const VESSEL_RUNTIME_STATE_VERSION = 2;
const registry = createVesselRegistry();
const nativeWorldInstances = new WeakMap();
const preparedWorlds = new WeakSet();
let vesselPluginsInstalled = false;
registry.registerPreset(STANDARD_BOAT_PRESET);
registry.registerPreset(LEGACY_BOAT_PRESET);
installVesselContent(registry);

function ensureVesselPluginsInstalled() {
  if (vesselPluginsInstalled) return;
  installVesselPlugins(registry);
  vesselPluginsInstalled = true;
}

function worldIndex(world) {
  let index = nativeWorldInstances.get(world);
  if (!index) {
    index = {byBoatId: new Map(), byInstanceId: new Map()};
    nativeWorldInstances.set(world, index);
  }
  return index;
}

function nextBoatSlot(world) {
  const boats = world.boats || (world.boats = []);
  const empty = boats.findIndex(value => value == null);
  return empty >= 0 ? empty : boats.length;
}

function integerOrNull(value) { return Number.isInteger(value) ? value : null; }

function safeTypeId(boat) {
  const raw = String(boat?.vesselType || boat?.boatType || boat?.type || "standard").toLowerCase();
  const clean = raw.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "standard";
}

function copyMigratedIdentity(world, migrated) {
  world.vesselArchitecture = cloneData(migrated.vesselArchitecture);
  for (let index = 0; index < (world.boats || []).length; index += 1) {
    const source = migrated.boats?.[index];
    const target = world.boats[index];
    if (!source || !target) continue;
    target.vesselInstanceId = source.vesselInstanceId;
    target.vesselType = source.vesselType;
    if (source.vesselRuntimeState !== undefined) target.vesselRuntimeState = cloneData(source.vesselRuntimeState);
  }
}

function prepareWorldMetadata(world) {
  if (preparedWorlds.has(world)) return;
  const migrated = migratePersistedVesselWorld(world);
  copyMigratedIdentity(world, migrated);
  preparedWorlds.add(world);
}

function allocateInstanceId(world, typeId) {
  world.vesselArchitecture ||= {saveVersion: VESSEL_SAVE_VERSION, contractVersion: 2, nextInstanceSequence: 1};
  let sequence = Math.max(1, Math.floor(Number(world.vesselArchitecture.nextInstanceSequence) || 1));
  const index = worldIndex(world);
  let id = `vessel:${typeId}:i${sequence}`;
  while (index.byInstanceId.has(id)) {
    sequence += 1;
    id = `vessel:${typeId}:i${sequence}`;
  }
  world.vesselArchitecture.nextInstanceSequence = sequence + 1;
  return id;
}

function runtimeState(definition, boat) {
  const state = {};
  for (const field of definition?.runtimeStateFields || []) if (boat?.[field] !== undefined) state[field] = cloneData(boat[field]);
  return state;
}

function authoritativeModuleState(definition) {
  return Object.values(definition?.subsystemAuthority || {}).some(value => String(value || "legacy") !== "legacy");
}

function finiteHealth(state, fallback = 100) {
  const value = Number(state?.health);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function syncModuleState(entry) {
  const {definition, instance, boat} = entry;
  if (instance.modules.engine) {
    const engine = instance.modules.engine;
    engine.health = finiteHealth(engine);
    if (vesselOwnsSubsystem(definition, "propulsion")) {
      if (boat.sunk || engine.health <= 0) engine.enabled = false;
      else if (typeof engine.enabled !== "boolean") engine.enabled = true;
      if (engine.enabled === false || engine.health <= 0) {
        boat.engineStalled = true;
        boat.throttle = 0;
      }
    } else {
      engine.enabled = !boat.engineStalled && !boat.sunk;
      if (boat.sunk) engine.health = 0;
    }
  }
  if (instance.modules["bilge-pump"]) {
    const pump = instance.modules["bilge-pump"];
    pump.health = finiteHealth(pump);
    if (pump.health <= 0) pump.enabled = false;
    pump.active = !boat.sunk && pump.enabled !== false && boat.pumpActive === true;
  }
  if (instance.modules.fuel) instance.modules.fuel.amount = Math.max(0, Number(boat.fuel) || 0);
  if (instance.modules.cargo) instance.modules.cargo.items = cloneData(boat.cargo || []);
  const mounted = Object.keys(instance.installations || {}).filter(id => instance.installations[id]?.type === "mounted-weapon");
  const turrets = Array.isArray(boat.turrets) ? boat.turrets : [];
  for (let index = 0; index < mounted.length && index < turrets.length; index += 1) {
    const module = instance.modules[mounted[index]];
    module.ammo = Math.max(0, Math.floor(Number(turrets[index]?.ammo) || 0));
    module.enabled = !boat.sunk && module.health > 0;
  }
}

function persistedRuntime(boat) {
  const value = boat?.vesselRuntimeState;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function restoreStaticModules(definition, instance, persisted) {
  const saved = persisted?.staticModules || {};
  for (const module of definition.modules || []) {
    const state = saved[module.id];
    if (!state || !instance.modules?.[module.id]) continue;
    instance.modules[module.id] = {...instance.modules[module.id], ...cloneData(state)};
  }
}

function restoreDynamicModules(definition, instance, persisted) {
  const installations = persisted?.dynamicInstallations || {};
  for (const [id, installation] of Object.entries(installations)) {
    if (instance.installations[id]) continue;
    if (!registry.resolveModuleType(String(installation?.type || ""))) continue;
    installVesselModule(registry, definition, instance, {
      id,
      type: installation.type,
      mounts: installation.mounts || [],
      config: installation.config || {},
      state: persisted?.dynamicModules?.[id] || {},
    });
  }
}

function restoreLiveOccupants(world, definition, instance, boatId, persisted) {
  if (!definition?.capabilities?.walkableInterior) return;
  for (const [rawIndex, previous] of Object.entries(persisted?.occupantMemory || {})) {
    const playerIndex = Number(rawIndex);
    if (!Number.isInteger(playerIndex) || world?.players?.[playerIndex]?.activeBoat !== boatId) continue;
    const position = safeReconnectPosition(definition, instance, playerIndex, previous);
    if (!position) continue;
    try { setVesselOccupantPosition(definition, instance, playerIndex, position); } catch (_) {}
  }
}

function persistentModuleSubset(moduleType, state) {
  if (!state || typeof state !== "object") return {};
  const fields = Array.isArray(moduleType?.persistentStateFields)
    ? moduleType.persistentStateFields
    : ["enabled", "health"];
  const result = {};
  for (const field of fields) if (Object.hasOwn(state, field)) result[field] = cloneData(state[field]);
  return result;
}

function compactStaticModules(definition, instance) {
  if (!authoritativeModuleState(definition)) return {};
  const result = {};
  for (const module of definition.modules || []) {
    const state = instance.modules?.[module.id];
    if (!state) continue;
    const moduleType = registry.resolveModuleType(module.type);
    result[module.id] = persistentModuleSubset(moduleType, state);
  }
  return result;
}

function compactDynamicModules(definition, instance) {
  const staticIds = new Set((definition.modules || []).map(module => module.id));
  const dynamicInstallations = {};
  const dynamicModules = {};
  for (const [id, installation] of Object.entries(instance.installations || {})) {
    if (staticIds.has(id)) continue;
    dynamicInstallations[id] = cloneData(installation);
    if (instance.modules?.[id] !== undefined) dynamicModules[id] = cloneData(instance.modules[id]);
  }
  return {dynamicInstallations, dynamicModules};
}

function persistNativeEntry(entry) {
  const {definition, instance, boat} = entry;
  const previousMemory = boat.vesselRuntimeState?.occupantMemory || {};
  const occupantMemory = {...cloneData(previousMemory), ...cloneData(instance.occupants || {})};
  const staticModules = compactStaticModules(definition, instance);
  const dynamic = compactDynamicModules(definition, instance);
  const deckEnabled = definition.deckArchitecture?.enabled === true;
  const hasStatic = Object.keys(staticModules).length > 0;
  const hasDynamic = Object.keys(dynamic.dynamicInstallations).length > 0;
  const hasMemory = Object.keys(occupantMemory).length > 0;
  if (!deckEnabled && !hasStatic && !hasDynamic && !hasMemory) {
    if (boat.vesselRuntimeState?.version === VESSEL_RUNTIME_STATE_VERSION) delete boat.vesselRuntimeState;
    return;
  }
  boat.vesselRuntimeState = {
    version: VESSEL_RUNTIME_STATE_VERSION,
    staticModules,
    dynamicModules: dynamic.dynamicModules,
    dynamicInstallations: dynamic.dynamicInstallations,
    deck: deckEnabled ? vesselDeckPersistentState(registry, definition, instance) : null,
    occupantMemory,
  };
}

function syncNativeEntry(entry) {
  if (!entry) return null;
  entry.instance.state = runtimeState(entry.definition, entry.boat);
  syncModuleState(entry);
  persistNativeEntry(entry);
  return entry;
}

function adoptBoat(world, boat, fallbackBoatId = null) {
  if (!boat) return null;
  const boatId = Number.isInteger(boat.id) ? boat.id : fallbackBoatId;
  if (!Number.isInteger(boatId)) return null;
  boat.id = boatId;
  const typeId = safeTypeId(boat);
  const definition = registry.resolveVesselType(typeId);
  if (!definition) return null;
  const index = worldIndex(world);
  const previous = index.byBoatId.get(boatId);
  if (previous?.boat === boat && previous.instance.typeId === definition.id) return syncNativeEntry(previous);
  const instanceId = String(boat.vesselInstanceId || "").trim() || allocateInstanceId(world, definition.id);
  if (index.byInstanceId.has(instanceId) && index.byInstanceId.get(instanceId)?.boat !== boat) throw new VesselContractError(`duplicate live vessel instanceId ${instanceId}`);
  boat.vesselInstanceId = instanceId;
  boat.vesselType = definition.id;
  boat.boatType ||= definition.id;
  boat.label ||= definition.presentation.label;
  const persisted = persistedRuntime(boat);
  const instance = registry.createInstance(definition.id, {
    instanceId,
    legacyBoatId: boatId,
    state: runtimeState(definition, boat),
    deckState: persisted?.deck || null,
  });
  restoreStaticModules(definition, instance, persisted);
  restoreDynamicModules(definition, instance, persisted);
  restoreLiveOccupants(world, definition, instance, boatId, persisted);
  const entry = {instance, boat, definition, adoptedLegacy: true};
  index.byBoatId.set(boatId, entry);
  index.byInstanceId.set(instanceId, entry);
  return syncNativeEntry(entry);
}

function syncNativeWorld(world) {
  if (!world || !Array.isArray(world.boats)) return [];
  prepareWorldMetadata(world);
  const index = worldIndex(world);
  const presentBoatIds = new Set();
  for (let boatId = 0; boatId < world.boats.length; boatId += 1) {
    const boat = world.boats[boatId];
    if (!boat) continue;
    const id = Number.isInteger(boat.id) ? boat.id : boatId;
    presentBoatIds.add(id);
    adoptBoat(world, boat, id);
  }
  for (const [boatId, entry] of [...index.byBoatId]) {
    if (presentBoatIds.has(boatId) && world.boats[boatId] === entry.boat) continue;
    index.byBoatId.delete(boatId);
    index.byInstanceId.delete(entry.instance.instanceId);
  }
  for (const entry of index.byInstanceId.values()) {
    syncNativeEntry(entry);
    syncWalkableVesselOccupants(world, entry.definition, entry.instance, entry.boat);
  }
  return [...index.byInstanceId.values()];
}

export function vesselRegistry() {
  ensureVesselPluginsInstalled();
  return registry;
}

export function spawnVessel(world, typeId, options = {}) {
  if (!world) throw new VesselContractError("spawnVessel needs a world");
  if (!Array.isArray(world.boats)) throw new VesselContractError("spawnVessel needs world.boats");
  prepareWorldMetadata(world);
  const definition = registry.resolveVesselType(typeId);
  if (!definition) throw new VesselContractError(`cannot spawn unregistered vessel type ${typeId}`);
  const legacyBoatId = Number.isInteger(options.legacyBoatId) ? options.legacyBoatId : nextBoatSlot(world);
  if (world.boats[legacyBoatId] != null) throw new VesselContractError(`world.boats[${legacyBoatId}] is already occupied`);
  const owner = integerOrNull(options.owner);
  const state = {...cloneData(definition.runtimeDefaults || {}), ...cloneData(options.state || {})};
  const instanceId = String(options.instanceId || "").trim() || allocateInstanceId(world, definition.id);
  const instance = registry.createInstance(typeId, {instanceId, legacyBoatId, state, moduleState: options.moduleState || {}, deckState: options.deckState || null});
  const boat = {
    ...state,
    id: legacyBoatId,
    owner,
    driver: integerOrNull(state.driver) ?? owner,
    boatType: definition.id,
    vesselType: definition.id,
    vesselInstanceId: instance.instanceId,
    label: definition.presentation.label,
    crewCapacity: Math.max(1, Math.floor(Number(state.crewCapacity) || 1)),
    crew: Array.isArray(state.crew) ? [...state.crew] : (owner == null ? [] : [owner]),
    x: Number(options.x ?? state.x) || 0,
    y: Number(options.y ?? state.y) || 0,
    heading: Number(options.heading ?? state.heading) || 0,
  };
  if (definition.physics?.mode === "profile" && !boat.physicsProfile) boat.physicsProfile = {id: String(definition.physics.profile || "standard")};
  world.boats[legacyBoatId] = boat;
  const entry = {instance, boat, definition, adoptedLegacy: false};
  const index = worldIndex(world);
  index.byBoatId.set(legacyBoatId, entry);
  index.byInstanceId.set(instance.instanceId, entry);
  persistNativeEntry(entry);
  syncLegacyVesselWorld(world);
  return {instance, boat, definition};
}

export function nativeVesselForBoat(world, boatId) {
  syncNativeWorld(world);
  return worldIndex(world).byBoatId.get(boatId) || null;
}

export function nativeVesselByInstanceId(world, instanceId) {
  syncNativeWorld(world);
  return worldIndex(world).byInstanceId.get(String(instanceId || "")) || null;
}

export function listNativeVessels(world) { return syncNativeWorld(world); }

export function attachVesselArchitecture(world) {
  syncNativeWorld(world);
  syncLegacyVesselWorld(world);
  return world;
}

export function detachVesselOccupant(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  const boatId = Number.isInteger(player?.activeBoat) ? player.activeBoat : null;
  if (boatId == null) return false;
  const entry = nativeVesselForBoat(world, boatId);
  if (!entry?.definition?.capabilities?.walkableInterior) return false;
  const local = entry.instance.occupants?.[playerIndex] ? cloneData(entry.instance.occupants[playerIndex]) : null;
  if (local) {
    entry.boat.vesselRuntimeState ||= {version: VESSEL_RUNTIME_STATE_VERSION};
    entry.boat.vesselRuntimeState.occupantMemory ||= {};
    entry.boat.vesselRuntimeState.occupantMemory[playerIndex] = local;
  }
  releaseVesselOccupantResources(entry.instance, playerIndex);
  return clearVesselOccupantPosition(entry.instance, playerIndex);
}

export function restoreVesselOccupant(world, playerIndex, boatId) {
  const entry = nativeVesselForBoat(world, boatId);
  if (!entry?.definition?.capabilities?.walkableInterior) return null;
  const previous = entry.boat.vesselRuntimeState?.occupantMemory?.[playerIndex] || null;
  const position = safeReconnectPosition(entry.definition, entry.instance, playerIndex, previous);
  if (!position) return null;
  setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, position);
  return position;
}

export function runVesselPhysics(context = {}) {
  const world = context.world;
  if (!world) return world;
  for (const entry of syncNativeWorld(world)) {
    const physics = entry.definition.physics;
    if (physics?.mode !== "module") continue;
    const module = registry.resolvePhysicsModule(physics.module);
    if (!module) throw new VesselContractError(`missing physics module ${physics.module}`);
    module.step({...context, registry, definition: entry.definition, instance: entry.instance, boat: entry.boat});
  }
  return world;
}

export function runVesselSystems(phase, context = {}) {
  ensureVesselPluginsInstalled();
  const world = context.world;
  const nativeVessels = world ? syncNativeWorld(world) : [];
  if (world) syncLegacyVesselWorld(world);
  if (phase === "before-step") {
    for (const entry of nativeVessels) {
      if (!entry.definition.deckArchitecture?.enabled) continue;
      advanceVesselDeckRuntime(entry.definition, entry.instance, context.dt, {boat: entry.boat, world, context});
    }
  }
  registry.runSystems(phase, {...context, registry, vessels: world ? legacyVesselViews(world) : [], nativeVessels});
  if (world) syncNativeWorld(world);
  return world;
}

export function replicatedVesselArchitecture(world) {
  return vesselNetworkSnapshot(world, registry, syncNativeWorld(world));
}

export {syncLegacyVesselWorld, legacyVesselViews};