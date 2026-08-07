"use strict";

import {
  VESSEL_CONTRACT_VERSION,
  VesselContractError,
  assertId,
  assertPlainObject,
  cloneData,
  isPlainObject,
  normalizeCapabilities,
  normalizeModuleType,
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
  };
}

export function createVesselRegistry() {
  const presets = new Map();
  const moduleTypes = new Map();
  const vesselTypes = new Map();
  const systems = new Map();

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

  function normalizeModuleInstance(instance, vesselTypeId) {
    const source = assertPlainObject(instance, `module instance in ${vesselTypeId}`);
    const instanceId = assertId(source.id, `module instance id in ${vesselTypeId}`);
    const type = assertId(source.type, `module type for ${instanceId}`);
    const moduleType = moduleTypes.get(type);
    if (!moduleType) throw new VesselContractError(`vessel ${vesselTypeId} references unregistered module type ${type}`);
    const config = cloneData(source.config || {});
    moduleType.validateConfig?.(config, {vesselTypeId, moduleInstanceId: instanceId});
    return Object.freeze({...cloneData(source), id: instanceId, type, config: Object.freeze(config)});
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
    const modules = Object.freeze((expanded.modules || []).map(module => normalizeModuleInstance(module, typeId)));
    const presentation = isPlainObject(expanded.presentation) ? Object.freeze(cloneData(expanded.presentation)) : Object.freeze({});
    const label = String(presentation.label || expanded.label || "").trim();
    if (!label) throw new VesselContractError(`vessel ${typeId} needs a user-facing label`);
    return Object.freeze({
      ...expanded,
      id: typeId,
      contractVersion: VESSEL_CONTRACT_VERSION,
      capabilities,
      modules,
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
    for (const module of definition.modules) {
      const moduleType = moduleTypes.get(module.type);
      const initial = moduleType?.createState ? moduleType.createState(module.config, {vesselType: definition, module}) : {};
      modules[module.id] = {...cloneData(initial), ...cloneData(moduleState[module.id] || {})};
    }
    return {
      instanceId: id,
      typeId: definition.id,
      legacyBoatId: Number.isInteger(legacyBoatId) ? legacyBoatId : null,
      state: cloneData(state),
      modules,
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
    resolveVesselType,
    resolveModuleType: id => moduleTypes.get(assertId(id, "module type id")) || null,
    createInstance,
    runSystems,
    listPresets: () => [...presets.values()],
    listModuleTypes: () => [...moduleTypes.values()],
    listVesselTypes: () => [...vesselTypes.values()],
    listSystems: () => [...systems.values()],
  });
}
