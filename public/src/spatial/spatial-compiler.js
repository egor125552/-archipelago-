"use strict";

import {assertSpatialId, normalizeLocationDefinition, SpatialContractError} from "./spatial-contract.js";

export class SpatialCompileError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.name = "SpatialCompileError";
    this.diagnostics = diagnostics;
  }
}

function diagnostic(level, code, message, details = {}) {
  return Object.freeze({level, code, message, ...details});
}

export function createSpatialModuleRegistry(definitions = []) {
  const entries = new Map();
  const api = {
    register(definition) {
      if (!definition || typeof definition !== "object") throw new TypeError("spatial module definition must be an object");
      const id = assertSpatialId(definition.id, "spatial module type id");
      if (entries.has(id)) throw new Error(`duplicate spatial module type ${id}`);
      if (definition.validateConfig != null && typeof definition.validateConfig !== "function") throw new TypeError(`spatial module ${id} validateConfig must be a function`);
      if (definition.create != null && typeof definition.create !== "function") throw new TypeError(`spatial module ${id} create must be a function`);
      entries.set(id, Object.freeze({...definition, id}));
      return api;
    },
    get(id) {
      return entries.get(id) || null;
    },
    has(id) {
      return entries.has(id);
    },
    list() {
      return [...entries.values()];
    },
  };
  for (const definition of definitions) api.register(definition);
  return api;
}

export function compileSpatialLocation(definition, {moduleRegistry = createSpatialModuleRegistry(), mode = "development"} = {}) {
  let location;
  try {
    location = normalizeLocationDefinition(definition);
  } catch (error) {
    if (error instanceof SpatialContractError) {
      const entry = diagnostic("error", "spatial.contract.invalid", error.message, {details: error.details});
      throw new SpatialCompileError(`location contract is invalid: ${error.message}`, [entry]);
    }
    throw error;
  }

  const diagnostics = [];
  const modulePlans = [];

  for (const warning of location.compatibility) {
    diagnostics.push(diagnostic("warning", warning.code, warning.message, {
      kind: "compatibility",
      locationId: location.id,
      legacySystem: warning.legacySystem,
      replacement: warning.replacement,
      targetId: warning.targetId,
    }));
  }

  for (const instance of location.modules) {
    const type = moduleRegistry.get(instance.type);
    if (!type) {
      const entry = diagnostic(instance.optional ? "warning" : "error", instance.optional ? "spatial.module.optional-missing" : "spatial.module.required-missing", `module ${instance.id} uses unavailable type ${instance.type}`, {
        locationId: location.id,
        moduleId: instance.id,
        moduleType: instance.type,
      });
      diagnostics.push(entry);
      if (!instance.optional) throw new SpatialCompileError(entry.message, diagnostics);
      modulePlans.push(Object.freeze({instance, type: null, disabledReason: "missing-type"}));
      continue;
    }

    try {
      type.validateConfig?.(instance.config, {location});
      modulePlans.push(Object.freeze({instance, type, disabledReason: null}));
    } catch (error) {
      const entry = diagnostic(instance.optional ? "warning" : "error", instance.optional ? "spatial.module.optional-invalid" : "spatial.module.required-invalid", `module ${instance.id} rejected its config: ${error?.message || error}`, {
        locationId: location.id,
        moduleId: instance.id,
        moduleType: instance.type,
      });
      diagnostics.push(entry);
      if (!instance.optional || mode === "development" && instance.optional !== true) throw new SpatialCompileError(entry.message, diagnostics);
      modulePlans.push(Object.freeze({instance, type, disabledReason: "invalid-config"}));
    }
  }

  const spacesById = new Map(location.spaces.map(space => [space.id, space]));
  const connectionsById = new Map(location.connections.map(connection => [connection.id, connection]));
  const anchorsById = new Map();
  const objectsById = new Map();
  for (const space of location.spaces) {
    for (const anchor of space.anchors) anchorsById.set(anchor.id, Object.freeze({spaceId: space.id, anchor}));
    for (const object of space.objects) objectsById.set(object.id, Object.freeze({spaceId: space.id, object}));
  }
  const spawnsById = new Map(location.spawns.map(spawn => [spawn.id, spawn]));

  return Object.freeze({
    ...location,
    spacesById,
    connectionsById,
    anchorsById,
    objectsById,
    spawnsById,
    modulePlans: Object.freeze(modulePlans),
    diagnostics: Object.freeze(diagnostics),
  });
}
