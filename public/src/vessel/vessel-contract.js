"use strict";

export const VESSEL_CONTRACT_VERSION = 1;

const ID_RE = /^[a-z][A-Za-z0-9._:-]*$/;
const SYSTEM_PHASES = new Set(["before-input", "after-input", "before-step", "after-step", "present"]);

export class VesselContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VesselContractError";
    this.details = details;
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertId(value, field = "id") {
  const id = String(value || "").trim();
  if (!ID_RE.test(id)) throw new VesselContractError(`${field} must be a stable id`, {field, value});
  return id;
}

export function assertPlainObject(value, field) {
  if (!isPlainObject(value)) throw new VesselContractError(`${field} must be an object`, {field, value});
  return value;
}

export function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneData(entry)]));
}

export function normalizeCapabilities(value = {}) {
  assertPlainObject(value, "capabilities");
  const result = {};
  for (const [key, enabled] of Object.entries(value)) {
    const id = assertId(key, `capability:${key}`);
    if (typeof enabled !== "boolean") {
      throw new VesselContractError(`capability ${id} must be boolean`, {capability: id, value: enabled});
    }
    result[id] = enabled;
  }
  return Object.freeze(result);
}

function normalizeEventPresentation(value, moduleId) {
  if (typeof value === "string") return Object.freeze({template: value});
  const entry = assertPlainObject(value, `module ${moduleId} presentation event`);
  const template = String(entry.template || "").trim();
  if (!template) throw new VesselContractError(`module ${moduleId} presentation event needs a template`);
  return Object.freeze({...cloneData(entry), template});
}

export function normalizePresentation(value, {moduleId, userFacing = true, semanticEvents = []} = {}) {
  if (!userFacing && value == null) return null;
  const presentation = assertPlainObject(value, `module ${moduleId} presentation`);
  const label = String(presentation.label || "").trim();
  if (!label) throw new VesselContractError(`user-facing module ${moduleId} needs presentation.label`);
  const events = {};
  const sourceEvents = isPlainObject(presentation.events) ? presentation.events : {};
  for (const [kind, eventPresentation] of Object.entries(sourceEvents)) {
    events[assertId(kind, `module ${moduleId} presentation event`)] = normalizeEventPresentation(eventPresentation, moduleId);
  }
  for (const kind of semanticEvents) {
    if (!events[kind]) {
      throw new VesselContractError(`user-facing module ${moduleId} is missing speech metadata for ${kind}`, {moduleId, kind});
    }
  }
  return Object.freeze({
    ...cloneData(presentation),
    label,
    forms: Object.freeze({...cloneData(presentation.forms || {})}),
    roles: Object.freeze({...cloneData(presentation.roles || {})}),
    events: Object.freeze(events),
  });
}

export function normalizeModuleType(definition) {
  const source = assertPlainObject(definition, "module type");
  const id = assertId(source.id, "module type id");
  const semanticEvents = Object.freeze([...(source.semanticEvents || [])].map(event => assertId(event, `module ${id} semantic event`)));
  const userFacing = source.userFacing !== false;
  const capabilities = Object.freeze([...(source.capabilities || [])].map(capability => assertId(capability, `module ${id} capability`)));
  const presentation = normalizePresentation(source.presentation, {moduleId: id, userFacing, semanticEvents});
  if (source.createState != null && typeof source.createState !== "function") {
    throw new VesselContractError(`module ${id} createState must be a function`);
  }
  if (source.validateConfig != null && typeof source.validateConfig !== "function") {
    throw new VesselContractError(`module ${id} validateConfig must be a function`);
  }
  return Object.freeze({...source, id, semanticEvents, capabilities, userFacing, presentation});
}

export function normalizeSystemPlugin(plugin) {
  const source = assertPlainObject(plugin, "vessel system plugin");
  const id = assertId(source.id, "vessel system id");
  const phase = String(source.phase || "");
  if (!SYSTEM_PHASES.has(phase)) throw new VesselContractError(`vessel system ${id} has invalid phase ${phase}`);
  if (typeof source.run !== "function") throw new VesselContractError(`vessel system ${id} needs run(context)`);
  const order = Number.isFinite(Number(source.order)) ? Number(source.order) : 0;
  return Object.freeze({...source, id, phase, order});
}

export function normalizePreset(preset) {
  const source = assertPlainObject(preset, "vessel preset");
  const id = assertId(source.id, "vessel preset id");
  return Object.freeze({...cloneData(source), id, capabilities: normalizeCapabilities(source.capabilities || {})});
}
