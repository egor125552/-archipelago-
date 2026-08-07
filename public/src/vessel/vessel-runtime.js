"use strict";

import {VesselContractError} from "./vessel-contract.js";
import {createVesselRegistry} from "./vessel-registry.js";
import {STANDARD_BOAT_PRESET, LEGACY_BOAT_PRESET} from "./vessel-defaults.js";
import {syncLegacyVesselWorld, legacyVesselViews} from "./vessel-legacy-adapter.js";
import {installVesselContent} from "./vessel-content-manifest.js";
import {installVesselPlugins} from "./vessel-plugin-manifest.js";

const registry = createVesselRegistry();
const nativeWorldInstances = new WeakMap();
registry.registerPreset(STANDARD_BOAT_PRESET);
registry.registerPreset(LEGACY_BOAT_PRESET);
installVesselContent(registry);
installVesselPlugins(registry);

function nativeInstances(world) {
  let instances = nativeWorldInstances.get(world);
  if (!instances) {
    instances = new Map();
    nativeWorldInstances.set(world, instances);
  }
  return instances;
}

function nextBoatSlot(world) {
  const boats = world.boats || (world.boats = []);
  const empty = boats.findIndex(value => value == null);
  return empty >= 0 ? empty : boats.length;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

export function vesselRegistry() {
  return registry;
}

export function spawnVessel(world, typeId, options = {}) {
  if (!world) throw new VesselContractError("spawnVessel needs a world");
  if (!Array.isArray(world.boats)) throw new VesselContractError("spawnVessel needs world.boats");
  const definition = registry.resolveVesselType(typeId);
  if (!definition) throw new VesselContractError(`cannot spawn unregistered vessel type ${typeId}`);

  const legacyBoatId = Number.isInteger(options.legacyBoatId) ? options.legacyBoatId : nextBoatSlot(world);
  if (world.boats[legacyBoatId] != null) throw new VesselContractError(`world.boats[${legacyBoatId}] is already occupied`);
  const owner = integerOrNull(options.owner);
  const state = {
    ...(definition.runtimeDefaults || {}),
    ...(options.state || {}),
  };
  const instance = registry.createInstance(typeId, {
    instanceId: options.instanceId || `${typeId}:${legacyBoatId}`,
    legacyBoatId,
    state,
    moduleState: options.moduleState || {},
  });
  const boat = {
    ...state,
    id: legacyBoatId,
    owner,
    driver: integerOrNull(state.driver) ?? owner,
    boatType: definition.id,
    vesselType: definition.id,
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
  nativeInstances(world).set(legacyBoatId, {instance, boat});
  syncLegacyVesselWorld(world);
  return {instance, boat};
}

export function nativeVesselForBoat(world, boatId) {
  return nativeWorldInstances.get(world)?.get(boatId) || null;
}

export function attachVesselArchitecture(world) {
  syncLegacyVesselWorld(world);
  return world;
}

export function runVesselSystems(phase, context = {}) {
  const world = context.world;
  if (world) syncLegacyVesselWorld(world);
  registry.runSystems(phase, {
    ...context,
    registry,
    vessels: world ? legacyVesselViews(world) : [],
    nativeVessels: world ? [...nativeInstances(world).values()] : [],
  });
  if (world) syncLegacyVesselWorld(world);
  return world;
}

export {syncLegacyVesselWorld, legacyVesselViews};
