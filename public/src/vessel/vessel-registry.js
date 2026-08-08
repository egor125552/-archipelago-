"use strict";

import {
  VESSEL_CONTRACT_VERSION,
  VesselContractError,
  assertId,
  assertPlainObject,
  cloneData,
  isPlainObject,
  normalizeCapabilities,
  normalizeDeck,
  normalizeModuleType,
  normalizeMount,
  normalizePhysics,
  normalizePhysicsModule,
  normalizePreset,
  normalizeSystemPlugin,
} from "./vessel-contract.js";

const DEFAULT_INSTANCE_PREFIX = "vessel";

function mergeObjects(base = {}, overrides = {}) {
  return {...cloneData(base), ...cloneData(overrides)};
}

function mergeDefinition(base, overrides) {
  return {
    ...cloneData(base),
    ...cloneData(overrides),
    capabilities: {...cloneData(base?.capabilities || {}), ...cloneData(overrides?.capabilities || {})},
    physics: mergeObjects(base?.physics, overrides?.physics),
    presentation: mergeObjects(base?.presentation, overrides?.presentation),
    modules: overrides?.modules == null ? cloneData(base?.modules || []) : cloneData(overrides.modules),
    mounts: overrides?.mounts == null ? cloneData(base?.mounts || []) : cloneData(overrides.mounts),
    decks: overrides?.decks == null ? cloneData(base?.decks || []) : cloneData(overrides.decks),
    stations: overrides?.stations == null ? cloneData(base?.stations || []) : cloneData(overrides.stations),
  };
}

function uniqueIds(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new VesselContractError(`${field} contains duplicate id ${item.id}`);
    seen.add(item.id);
  }
}

export function createVesselRegistry() {
  const presets = new Map();
  const moduleTypes = new Map();
  const vesselTypes = new Map();
  const systems = new Map();
  const physicsModules = new Map();

  function registerUnique(map, kind, definition, normalizer) {
    const normalized = normalizer(definition);
    if (map.has(normalized.id)) throw new VesselContractError(`${kind} ${normalized.id} is already registered`);
    map.set(normalized.id, normalized);
    return normalized;
  }

  function registerPreset(definition) {
    return registerUnique(presets, "preset", definition, normalizePreset);
  }

  function registerModuleType(definition) {
    return registerUnique(moduleTypes, "module type", definition, normalizeModuleType);
  }

  function registerSystem(plugin) {
    return registerUnique(systems, "vessel system", plugin, normalizeSystemPlugin);
  }

  function registerPhysicsModule(module) {
    return registerUnique(physicsModules, "vessel physics module", module, normalizePhysicsModule);
  }

  function normalizeModuleInstance(instance, vesselTypeId, mountById, occupiedMounts) {
    const source = assertPlainObject(instance, `module instance in ${vesselTypeId}`);
    const instanceId = assertId(source.id, `module instance id in ${vesselTypeId}`);
    const type = assertId(source.type, `module type for ${instanceId}`);
    const moduleType = moduleTypes.get(type);
    if (!moduleType) throw new VesselContractError(`vessel ${vesselTypeId} references unregistered module type ${type}`);
    const config = cloneData(source.config || {});
    moduleType.validateConfig?.(config, {vesselTypeId, moduleInstanceId: instanceId});
    const mounts = Object.freeze([...(source.mounts || [])].map(mountId => assertId(mountId, `module ${instanceId} mount`)));
    if (mounts.length !== moduleType.installation.mountCount) {
      throw new VesselContractError(`module ${instanceId} needs exactly ${moduleType.installation.mountCount} mounts`, {
        moduleInstanceId: instanceId,
        required: moduleType.installation.mountCount,
        received: mounts.length,
      });
    }
    if (new Set(mounts).size !== mounts.length) throw new VesselContractError(`module ${instanceId} cannot occupy the same mount twice`);
    for (const mountId of mounts) {
      const mount = mountById.get(mountId);
      if (!mount) throw new VesselContractError(`module ${instanceId} references missing mount ${mountId}`);
      const compatibleKind = moduleType.installation.mountKinds.includes(mount.kind);
      const explicitCompatibility = mount.accepts.includes(type);
      if (!compatibleKind && !explicitCompatibility) {
        throw new VesselContractError(`module ${instanceId} is incompatible with mount ${mountId}`, {moduleType: type, mountKind: mount.kind});
      }
      if (occupiedMounts.has(mountId)) {
        throw new VesselContractError(`mount ${mountId} is already occupied by ${occupiedMounts.get(mountId)}`);
      }
      occupiedMounts.set(mountId, instanceId);
    }
    return Object.freeze({...cloneData(source), id: instanceId, type, config: Object.freeze(config), mounts});
  }

  function normalizeVesselType(definition) {
    const original = assertPlainObject(definition, "vessel type");
    const typeId = assertId(original.id, "vessel type id");
    let expanded = cloneData(original);
    if (original.preset) {
      const presetId = assertId(original.preset, `vessel ${typeId} preset`);
      const preset = presets.get(presetId);
      if (!preset) throw new VesselContractError(`vessel ${typeId} references unregistered preset ${presetId}`);
      expanded = mergeDefinition(preset, original);
    }
    const capabilities = normalizeCapabilities(expanded.capabilities || {});
    const physics = normalizePhysics(expanded.physics || {mode: "profile", profile: "standard"});
    if (physics.mode === "module" && !physicsModules.has(physics.module)) {
      throw new VesselContractError(`vessel ${typeId} references unregistered physics module ${physics.module}`);
    }
    const mounts = Object.freeze((expanded.mounts || []).map(mount => normalizeMount(mount, typeId)));
    uniqueIds(mounts, `vessel ${typeId} mounts`);
    const mountById = new Map(mounts.map(mount => [mount.id, mount]));
    const occupiedMounts = new Map();
    const modules = Object.freeze((expanded.modules || []).map(module => normalizeModuleInstance(module, typeId, mountById, occupiedMounts)));
    uniqueIds(modules, `vessel ${typeId} modules`);
    const decks = Object.freeze((expanded.decks || []).map(deck => normalizeDeck(deck, typeId)));
    uniqueIds(decks, `vessel ${typeId} decks`);
    const deckIds = new Set(decks.map(deck => deck.id));
    for (const mount of mounts) {
      if (mount.deckId && !deckIds.has(mount.deckId)) throw new VesselContractError(`mount ${mount.id} references missing deck ${mount.deckId}`);
    }
    for (const deck of decks) {
      const zoneIds = new Set(deck.zones.map(zone => zone.id));
      for (const landmark of deck.landmarks) {
        if (landmark.zoneId && !zoneIds.has(landmark.zoneId)) {
          throw new VesselContractError(`landmark ${landmark.id} references missing zone ${landmark.zoneId}`);
        }
      }
      for (const connection of deck.connections) {
        if (!deckIds.has(connection.toDeckId)) {
          throw new VesselContractError(`connection ${connection.id} references missing deck ${connection.toDeckId}`);
        }
      }
    }
    const presentation = isPlainObject(expanded.presentation) ? Object.freeze(cloneData(expanded.presentation)) : Object.freeze({});
    const label = String(presentation.label || expanded.label || "").trim();
    if (!label) throw new VesselContractError(`vessel ${typeId} needs a user-facing label`);
    return Object.freeze({
      ...expanded,
      id: typeId,
      contractVersion: VESSEL_CONTRACT_VERSION,
      capabilities,
      physics,
      mounts,
      modules,
      decks,
      presentation: Object.freeze({...presentation, label}),
    });
  }

  function registerVesselType(definition) {
    const normalized = normalizeVesselType(definition);
    if (vesselTypes.has(normalized.id)) throw new VesselContractError(`vessel type ${normalized.id} is already registered`);
    vesselTypes.set(normalized.id, normalized);
    return normalized;
  }

  function resolveVesselType(id) {
    return vesselTypes.get(assertId(id, "vessel type id")) || null;
  }

  function createInstance(typeId, {instanceId, legacyBoatId = null, state = {}, moduleState = {}} = {}) {
    const definition = resolveVesselType(typeId);
    if (!definition) throw new VesselContractError(`unregistered vessel type ${typeId}`);
    const id = assertId(instanceId || `${DEFAULT_INSTANCE_PREFIX}:${typeId}`, "vessel instance id");
    const modules = {};
    const mountOccupancy = {};
    for (const module of definition.modules) {
      const moduleType = moduleTypes.get(module.type);
      const initial = moduleType?.createState ? moduleType.createState(module.config, {vesselType: definition, module}) : {};
      modules[module.id] = {...cloneData(initial), ...cloneData(moduleState[module.id] || {})};
      for (const mountId of module.mounts) mountOccupancy[mountId] = module.id;
    }
    return {
      instanceId: id,
      typeId: definition.id,
      legacyBoatId: Number.isInteger(legacyBoatId) ? legacyBoatId : null,
      state: cloneData(state),
      modules,
      mountOccupancy,
      installations: Object.fromEntries(definition.modules.map(module => [module.id, {type: module.type, mounts: [...module.mounts]}])),
      occupants: {},
      zones: {},
    };
  }

  function runSystems(phase, context) {
    const active = [...systems.values()]
      .filter(system => system.phase === phase)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    for (const system of active) system.run(context);
  }

  return Object.freeze({
    registerPreset,
    registerModuleType,
    registerVesselType,
    registerSystem,
    registerPhysicsModule,
    resolveVesselType,
    resolveModuleType: id => moduleTypes.get(assertId(id, "module type id")) || null,
    resolvePhysicsModule: id => physicsModules.get(assertId(id, "physics module id")) || null,
    createInstance,
    runSystems,
    listPresets: () => [...presets.values()],
    listModuleTypes: () => [...moduleTypes.values()],
    // Stress-prefixed types are live diagnostic fixtures, not release catalog
    // entries. Runtime resolution still sees them; production listings do not.
    listVesselTypes: ({includeStress = false} = {}) => [...vesselTypes.values()].filter(type => includeStress || !type.id.startsWith("stress-")),
    listSystems: () => [...systems.values()],
    listPhysicsModules: () => [...physicsModules.values()],
  });
}
