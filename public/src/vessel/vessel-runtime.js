"use strict";

import {VesselContractError, cloneData} from "./vessel-contract.js";
import {createVesselRegistry} from "./vessel-registry.js";
import {STANDARD_BOAT_PRESET, LEGACY_BOAT_PRESET} from "./vessel-defaults.js";
import {syncLegacyVesselWorld, legacyVesselViews} from "./vessel-legacy-adapter.js";
import {installVesselContent} from "./vessel-content-manifest.js";
import {installVesselPlugins} from "./vessel-plugin-manifest.js";
import {migratePersistedVesselWorld, VESSEL_SAVE_VERSION} from "./vessel-save.js";
import {syncWalkableVesselOccupants} from "./vessel-interior.js";
import {vesselNetworkSnapshot} from "./vessel-network.js";

const registry = createVesselRegistry();
const nativeWorldInstances = new WeakMap();
const preparedWorlds = new WeakSet();
registry.registerPreset(STANDARD_BOAT_PRESET);
registry.registerPreset(LEGACY_BOAT_PRESET);
installVesselContent(registry);
installVesselPlugins(registry);

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

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

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
  for (const field of definition?.runtimeStateFields || []) {
    if (boat?.[field] !== undefined) state[field] = cloneData(boat[field]);
  }
  return state;
}

function syncModuleState(entry) {
  const {instance, boat} = entry;
  if (instance.modules.engine) {
    instance.modules.engine.enabled = !boat.engineStalled && !boat.sunk;
    instance.modules.engine.health = boat.sunk ? 0 : Math.max(0, Number(instance.modules.engine.health) || 100);
  }
  if (instance.modules["bilge-pump"]) instance.modules["bilge-pump"].active = boat.pumpActive === true;
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

function syncNativeEntry(entry) {
  if (!entry) return null;
  entry.instance.state = runtimeState(entry.definition, entry.boat);
  syncModuleState(entry);
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
  if (index.byInstanceId.has(instanceId) && index.byInstanceId.get(instanceId)?.boat !== boat) {
    throw new VesselContractError(`duplicate live vessel instanceId ${instanceId}`);
  }
  boat.vesselInstanceId = instanceId;
  boat.vesselType = definition.id;
  boat.boatType ||= definition.id;
  boat.label ||= definition.presentation.label;
  const instance = registry.createInstance(definition.id, {
    instanceId,
    legacyBoatId: boatId,
    state: runtimeState(definition, boat),
  });
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
  const instance = registry.createInstance(typeId, {instanceId, legacyBoatId, state, moduleState: options.moduleState || {}});
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
  if (definition.physics?.mode === "profile" && !boat.physicsProfile) {
    boat.physicsProfile = {id: String(definition.physics.profile || "standard")};
  }

  world.boats[legacyBoatId] = boat;
  const entry = {instance, boat, definition, adoptedLegacy: false};
  const index = worldIndex(world);
  index.byBoatId.set(legacyBoatId, entry);
  index.byInstanceId.set(instance.instanceId, entry);
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

export function listNativeVessels(world) {
  return syncNativeWorld(world);
}

export function attachVesselArchitecture(world) {
  syncNativeWorld(world);
  syncLegacyVesselWorld(world);
  return world;
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
  const world = context.world;
  const nativeVessels = world ? syncNativeWorld(world) : [];
  if (world) syncLegacyVesselWorld(world);
  registry.runSystems(phase, {
    ...context,
    registry,
    vessels: world ? legacyVesselViews(world) : [],
    nativeVessels,
  });
  if (world) syncNativeWorld(world);
  return world;
}

export function replicatedVesselArchitecture(world) {
  return vesselNetworkSnapshot(world, registry, syncNativeWorld(world));
}

export {syncLegacyVesselWorld, legacyVesselViews};
