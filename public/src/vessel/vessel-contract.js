"use strict";

export const VESSEL_CONTRACT_VERSION = 2;

const ID_RE = /^[a-z][A-Za-z0-9._:-]*$/;
const SYSTEM_PHASES = new Set(["before-input", "after-input", "before-step", "after-step", "present"]);
const PHYSICS_MODES = new Set(["profile", "module", "legacy-object"]);
const CONNECTION_KINDS = new Set(["door", "hatch", "ladder", "gangway", "jump", "passage", "custom"]);
const TRAVERSAL_MODES = new Set(["instant", "timed", "geometry"]);

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
    if (typeof enabled !== "boolean") throw new VesselContractError(`capability ${id} must be boolean`, {capability: id, value: enabled});
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
  for (const [kind, eventPresentation] of Object.entries(sourceEvents)) events[assertId(kind, `module ${moduleId} presentation event`)] = normalizeEventPresentation(eventPresentation, moduleId);
  for (const kind of semanticEvents) if (!events[kind]) throw new VesselContractError(`user-facing module ${moduleId} is missing speech metadata for ${kind}`, {moduleId, kind});
  return Object.freeze({...cloneData(presentation), label, forms: Object.freeze({...cloneData(presentation.forms || {})}), roles: Object.freeze({...cloneData(presentation.roles || {})}), events: Object.freeze(events)});
}

export function normalizeNamedPresentation(value, fallbackLabel, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const label = String(source.label || fallbackLabel || "").trim();
  if (!label) throw new VesselContractError(`${field} needs a user-facing label`);
  return Object.freeze({...cloneData(source), label, forms: Object.freeze({...cloneData(source.forms || {})}), roles: Object.freeze({...cloneData(source.roles || {})})});
}

function normalizeInstallation(value, moduleId) {
  const source = value == null ? {} : assertPlainObject(value, `module ${moduleId} installation`);
  const mountCount = source.mountCount == null ? 0 : Number(source.mountCount);
  if (!Number.isInteger(mountCount) || mountCount < 0) throw new VesselContractError(`module ${moduleId} installation.mountCount must be a non-negative integer`);
  const mountKinds = Object.freeze([...(source.mountKinds || [])].map(kind => assertId(kind, `module ${moduleId} mount kind`)));
  return Object.freeze({...cloneData(source), mountCount, mountKinds});
}

export function normalizeModuleType(definition) {
  const source = assertPlainObject(definition, "module type");
  const id = assertId(source.id, "module type id");
  const semanticEvents = Object.freeze([...(source.semanticEvents || [])].map(event => assertId(event, `module ${id} semantic event`)));
  const userFacing = source.userFacing !== false;
  const capabilities = Object.freeze([...(source.capabilities || [])].map(capability => assertId(capability, `module ${id} capability`)));
  const presentation = normalizePresentation(source.presentation, {moduleId: id, userFacing, semanticEvents});
  const installation = normalizeInstallation(source.installation, id);
  if (source.createState != null && typeof source.createState !== "function") throw new VesselContractError(`module ${id} createState must be a function`);
  if (source.validateConfig != null && typeof source.validateConfig !== "function") throw new VesselContractError(`module ${id} validateConfig must be a function`);
  if (source.effectiveness != null && typeof source.effectiveness !== "function") throw new VesselContractError(`module ${id} effectiveness must be a function`);
  return Object.freeze({...source, id, semanticEvents, capabilities, userFacing, presentation, installation});
}

export function normalizeDeckRuleType(definition) {
  const source = assertPlainObject(definition, "deck rule type");
  const id = assertId(source.id, "deck rule type id");
  for (const field of ["validateConfig", "createState", "actions", "performAction"]) if (source[field] != null && typeof source[field] !== "function") throw new VesselContractError(`deck rule ${id} ${field} must be a function`);
  const persistentFields = source.persistentFields == null ? null : Object.freeze([...(source.persistentFields || [])].map(field => assertId(field, `deck rule ${id} persistent field`)));
  const networkStateFields = source.networkStateFields == null ? null : Object.freeze([...(source.networkStateFields || [])].map(field => assertId(field, `deck rule ${id} network field`)));
  return Object.freeze({...source, id, persistentFields, networkStateFields});
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

export function normalizePhysicsModule(module) {
  const source = assertPlainObject(module, "vessel physics module");
  const id = assertId(source.id, "vessel physics module id");
  if (typeof source.step !== "function") throw new VesselContractError(`vessel physics module ${id} needs step(context)`);
  return Object.freeze({...source, id});
}

export function normalizePreset(preset) {
  const source = assertPlainObject(preset, "vessel preset");
  const id = assertId(source.id, "vessel preset id");
  return Object.freeze({...cloneData(source), id, capabilities: normalizeCapabilities(source.capabilities || {})});
}

export function normalizePoint(value, field = "point") {
  if (Array.isArray(value) && value.length === 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return Object.freeze({x, y});
  }
  const source = assertPlainObject(value, field);
  const x = Number(source.x);
  const y = Number(source.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new VesselContractError(`${field} needs finite x/y`, {value});
  return Object.freeze({x, y});
}

function normalizePolygon(value, field) {
  const source = assertPlainObject(value, field);
  const outer = Object.freeze([...(source.outer || [])].map((point, index) => normalizePoint(point, `${field}.outer[${index}]`)));
  if (outer.length < 3) throw new VesselContractError(`${field}.outer needs at least three points`);
  const holes = Object.freeze([...(source.holes || [])].map((hole, holeIndex) => {
    const points = Object.freeze([...(hole || [])].map((point, index) => normalizePoint(point, `${field}.holes[${holeIndex}][${index}]`)));
    if (points.length < 3) throw new VesselContractError(`${field}.holes[${holeIndex}] needs at least three points`);
    return points;
  }));
  return Object.freeze({outer, holes});
}

export function normalizeMount(value, vesselId) {
  const source = assertPlainObject(value, `mount in ${vesselId}`);
  const id = assertId(source.id, `mount id in ${vesselId}`);
  const kind = assertId(source.kind || "generic", `mount ${id} kind`);
  const accepts = Object.freeze([...(source.accepts || [])].map(type => assertId(type, `mount ${id} accepted module type`)));
  const position = source.position == null ? null : normalizePoint(source.position, `mount ${id} position`);
  const deckId = source.deckId == null ? null : assertId(source.deckId, `mount ${id} deckId`);
  return Object.freeze({...cloneData(source), id, kind, accepts, position, deckId});
}

function normalizeZone(value, deckId) {
  const source = assertPlainObject(value, `zone in deck ${deckId}`);
  const id = assertId(source.id, `zone id in deck ${deckId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new VesselContractError(`zone ${id} needs a user-facing label`);
  const shape = source.shape == null ? null : normalizePolygon(source.shape, `zone ${id} shape`);
  const presentation = normalizeNamedPresentation(source.presentation, label, `zone ${id} presentation`);
  return Object.freeze({...cloneData(source), id, label, presentation, damageable: source.damageable === true, shape});
}

function normalizeLandmark(value, deckId) {
  const source = assertPlainObject(value, `landmark in deck ${deckId}`);
  const id = assertId(source.id, `landmark id in deck ${deckId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new VesselContractError(`landmark ${id} needs a user-facing label`);
  const position = normalizePoint(source.position, `landmark ${id} position`);
  const zoneId = source.zoneId == null ? null : assertId(source.zoneId, `landmark ${id} zoneId`);
  const presentation = normalizeNamedPresentation(source.presentation, label, `landmark ${id} presentation`);
  return Object.freeze({...cloneData(source), id, label, presentation, position, zoneId, navigation: source.navigation !== false});
}

function normalizeTraversal(value, connectionId) {
  const source = value == null ? {} : assertPlainObject(value, `connection ${connectionId} traversal`);
  const mode = String(source.mode || "instant");
  if (!TRAVERSAL_MODES.has(mode)) throw new VesselContractError(`connection ${connectionId} has invalid traversal mode ${mode}`);
  const result = {...cloneData(source), mode};
  if (source.duration != null && (!Number.isFinite(Number(source.duration)) || Number(source.duration) < 0)) throw new VesselContractError(`connection ${connectionId} traversal.duration must be non-negative`);
  if (source.speed != null && (!Number.isFinite(Number(source.speed)) || Number(source.speed) <= 0)) throw new VesselContractError(`connection ${connectionId} traversal.speed must be greater than zero`);
  return Object.freeze(result);
}

function normalizeConnection(value, deckId) {
  const source = assertPlainObject(value, `connection in deck ${deckId}`);
  const id = assertId(source.id, `connection id in deck ${deckId}`);
  const toDeckId = assertId(source.toDeckId, `connection ${id} toDeckId`);
  const label = String(source.label || source.presentation?.label || "переход").trim();
  const from = normalizePoint(source.from, `connection ${id} from`);
  const to = source.to == null ? null : normalizePoint(source.to, `connection ${id} to`);
  const kind = String(source.kind || "passage");
  if (!CONNECTION_KINDS.has(kind)) throw new VesselContractError(`connection ${id} has invalid kind ${kind}`);
  const states = Object.freeze([...(source.states || ["open", "closed", "locked", "jammed", "destroyed", "blocked"])].map(state => assertId(state, `connection ${id} state`)));
  const initialState = assertId(source.initialState || ((kind === "ladder" || kind === "jump" || kind === "passage") ? "open" : "closed"), `connection ${id} initialState`);
  if (!states.includes(initialState)) throw new VesselContractError(`connection ${id} initialState ${initialState} is not in states`);
  const passableStates = Object.freeze([...(source.passableStates || ["open", "destroyed"])].map(state => assertId(state, `connection ${id} passable state`)));
  for (const state of passableStates) if (!states.includes(state)) throw new VesselContractError(`connection ${id} passable state ${state} is not declared`);
  const reverseId = source.reverseId == null ? null : assertId(source.reverseId, `connection ${id} reverseId`);
  const traversal = normalizeTraversal(source.traversal, id);
  const presentation = normalizeNamedPresentation(source.presentation, label, `connection ${id} presentation`);
  return Object.freeze({...cloneData(source), id, toDeckId, label, presentation, kind, states, initialState, passableStates, reverseId, traversal, from, to});
}

function normalizeDeckObject(value, deckId) {
  const source = assertPlainObject(value, `object in deck ${deckId}`);
  const id = assertId(source.id, `object id in deck ${deckId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new VesselContractError(`object ${id} needs a user-facing label`);
  const kind = assertId(source.kind || "object", `object ${id} kind`);
  const position = normalizePoint(source.position, `object ${id} position`);
  const zoneId = source.zoneId == null ? null : assertId(source.zoneId, `object ${id} zoneId`);
  const presentation = normalizeNamedPresentation(source.presentation, label, `object ${id} presentation`);
  return Object.freeze({...cloneData(source), id, label, presentation, kind, position, zoneId});
}

export function normalizeDeck(value, vesselId) {
  const source = assertPlainObject(value, `deck in ${vesselId}`);
  const id = assertId(source.id, `deck id in ${vesselId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new VesselContractError(`deck ${id} needs a user-facing label`);
  const level = Number.isFinite(Number(source.level)) ? Number(source.level) : 0;
  const shape = normalizePolygon(source.shape, `deck ${id} shape`);
  const zones = Object.freeze([...(source.zones || [])].map(zone => normalizeZone(zone, id)));
  const landmarks = Object.freeze([...(source.landmarks || [])].map(landmark => normalizeLandmark(landmark, id)));
  const connections = Object.freeze([...(source.connections || [])].map(connection => normalizeConnection(connection, id)));
  const objects = Object.freeze([...(source.objects || [])].map(object => normalizeDeckObject(object, id)));
  const presentation = normalizeNamedPresentation(source.presentation, label, `deck ${id} presentation`);
  return Object.freeze({...cloneData(source), id, label, presentation, level, shape, zones, landmarks, connections, objects});
}

export function normalizePhysics(value = {}) {
  const source = assertPlainObject(value, "vessel physics");
  const mode = String(source.mode || "profile");
  if (!PHYSICS_MODES.has(mode)) throw new VesselContractError(`invalid vessel physics mode ${mode}`);
  const result = {...cloneData(source), mode};
  if (mode === "profile") result.profile = assertId(source.profile || "standard", "physics profile id");
  if (mode === "module") result.module = assertId(source.module, "physics module id");
  return Object.freeze(result);
}
