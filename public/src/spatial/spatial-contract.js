"use strict";

export const SPATIAL_SCHEMA_VERSION = 1;

const ID_RE = /^[a-z][A-Za-z0-9._:-]*$/;
const CONNECTION_KINDS = new Set(["passage", "door", "stairs", "ladder", "hatch", "lift", "vehicle", "automatic", "custom"]);
const TRAVERSAL_MODES = new Set(["instant", "timed", "physical", "scripted"]);

export class SpatialContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpatialContractError";
    this.details = details;
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneSpatialData(value) {
  if (Array.isArray(value)) return value.map(cloneSpatialData);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneSpatialData(entry)]));
}

export function assertSpatialId(value, field = "id") {
  const id = String(value || "").trim();
  if (!ID_RE.test(id)) throw new SpatialContractError(`${field} must be a stable id`, {field, value});
  return id;
}

function requireObject(value, field) {
  if (!isPlainObject(value)) throw new SpatialContractError(`${field} must be an object`, {field, value});
  return value;
}

function finite(value, field, fallback = null) {
  if (value == null && fallback != null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SpatialContractError(`${field} must be finite`, {field, value});
  return number;
}

export function normalizeVec3(value, field = "point") {
  if (Array.isArray(value) && (value.length === 2 || value.length === 3)) {
    return Object.freeze({
      x: finite(value[0], `${field}.x`),
      y: finite(value[1], `${field}.y`),
      z: value.length === 3 ? finite(value[2], `${field}.z`) : 0,
    });
  }
  const source = requireObject(value, field);
  return Object.freeze({
    x: finite(source.x, `${field}.x`),
    y: finite(source.y, `${field}.y`),
    z: source.z == null ? 0 : finite(source.z, `${field}.z`),
  });
}

export function normalizeTransform(value = {}, field = "transform") {
  const source = requireObject(value, field);
  const position = source.position == null ? Object.freeze({x: 0, y: 0, z: 0}) : normalizeVec3(source.position, `${field}.position`);
  const yaw = source.yaw == null ? 0 : finite(source.yaw, `${field}.yaw`);
  return Object.freeze({position, yaw});
}

function normalizePresentation(value, fallbackLabel, field) {
  const source = value == null ? {} : requireObject(value, field);
  const label = String(source.label || fallbackLabel || "").trim();
  if (!label) throw new SpatialContractError(`${field} needs a user-facing label`, {field});
  const description = String(source.description || "").trim();
  const role = source.role == null ? null : assertSpatialId(source.role, `${field}.role`);
  return Object.freeze({...cloneSpatialData(source), label, description, role});
}

function normalizePolygon(value, field) {
  const source = requireObject(value, field);
  const outer = Object.freeze([...(source.outer || [])].map((point, index) => normalizeVec3(point, `${field}.outer[${index}]`)));
  if (outer.length < 3) throw new SpatialContractError(`${field}.outer needs at least three points`, {field});
  const minZ = source.minZ == null ? Math.min(...outer.map(point => point.z)) : finite(source.minZ, `${field}.minZ`);
  const maxZ = source.maxZ == null ? Math.max(minZ, ...outer.map(point => point.z)) : finite(source.maxZ, `${field}.maxZ`);
  if (maxZ < minZ) throw new SpatialContractError(`${field}.maxZ must be >= minZ`, {field, minZ, maxZ});
  return Object.freeze({outer, minZ, maxZ});
}

function normalizeAnchor(value, spaceId) {
  const source = requireObject(value, `anchor in ${spaceId}`);
  const id = assertSpatialId(source.id, `anchor id in ${spaceId}`);
  const kind = assertSpatialId(source.kind || "landmark", `anchor ${id}.kind`);
  const position = normalizeVec3(source.position, `anchor ${id}.position`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new SpatialContractError(`anchor ${id} needs a user-facing label`, {spaceId, id});
  const presentation = normalizePresentation(source.presentation, label, `anchor ${id}.presentation`);
  return Object.freeze({...cloneSpatialData(source), id, kind, label, presentation, position, safe: source.safe !== false, navigation: source.navigation !== false});
}

function normalizeObject(value, spaceId) {
  const source = requireObject(value, `object in ${spaceId}`);
  const id = assertSpatialId(source.id, `object id in ${spaceId}`);
  const kind = assertSpatialId(source.kind || "object", `object ${id}.kind`);
  const position = normalizeVec3(source.position, `object ${id}.position`);
  const userFacing = source.userFacing !== false;
  const label = String(source.label || source.presentation?.label || "").trim();
  if (userFacing && !label) throw new SpatialContractError(`user-facing object ${id} needs a label`, {spaceId, id});
  const presentation = userFacing ? normalizePresentation(source.presentation, label, `object ${id}.presentation`) : null;
  return Object.freeze({...cloneSpatialData(source), id, kind, label, userFacing, presentation, position});
}

function normalizeAcoustics(value, spaceId) {
  if (value == null) return Object.freeze({profile: "open", gain: 1, lowpassHz: 20000, reverb: 0});
  const source = requireObject(value, `space ${spaceId}.acoustics`);
  const profile = assertSpatialId(source.profile || "open", `space ${spaceId}.acoustics.profile`);
  const gain = source.gain == null ? 1 : finite(source.gain, `space ${spaceId}.acoustics.gain`);
  const lowpassHz = source.lowpassHz == null ? 20000 : finite(source.lowpassHz, `space ${spaceId}.acoustics.lowpassHz`);
  const reverb = source.reverb == null ? 0 : finite(source.reverb, `space ${spaceId}.acoustics.reverb`);
  if (gain < 0 || gain > 1 || lowpassHz <= 0 || reverb < 0 || reverb > 1) {
    throw new SpatialContractError(`space ${spaceId}.acoustics has values outside supported range`, {spaceId});
  }
  return Object.freeze({...cloneSpatialData(source), profile, gain, lowpassHz, reverb});
}

function normalizeSpace(value, locationId) {
  const source = requireObject(value, `space in ${locationId}`);
  const id = assertSpatialId(source.id, `space id in ${locationId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new SpatialContractError(`space ${id} needs a user-facing label`, {locationId, id});
  const parentSpaceId = source.parentSpaceId == null ? null : assertSpatialId(source.parentSpaceId, `space ${id}.parentSpaceId`);
  const transform = normalizeTransform(source.transform || {}, `space ${id}.transform`);
  const shape = normalizePolygon(source.shape, `space ${id}.shape`);
  const presentation = normalizePresentation(source.presentation, label, `space ${id}.presentation`);
  const anchors = Object.freeze([...(source.anchors || [])].map(anchor => normalizeAnchor(anchor, id)));
  const objects = Object.freeze([...(source.objects || [])].map(object => normalizeObject(object, id)));
  const acoustics = normalizeAcoustics(source.acoustics, id);
  const activity = Object.freeze({
    sleepAllowed: source.activity?.sleepAllowed !== false,
    activeRadius: source.activity?.activeRadius == null ? 35 : finite(source.activity.activeRadius, `space ${id}.activity.activeRadius`),
    preloadRadius: source.activity?.preloadRadius == null ? 55 : finite(source.activity.preloadRadius, `space ${id}.activity.preloadRadius`),
  });
  return Object.freeze({...cloneSpatialData(source), id, label, parentSpaceId, transform, shape, presentation, anchors, objects, acoustics, activity, moving: source.moving === true});
}

function normalizeEndpoint(value, connectionId, side) {
  const source = requireObject(value, `connection ${connectionId}.${side}`);
  return Object.freeze({
    spaceId: assertSpatialId(source.spaceId, `connection ${connectionId}.${side}.spaceId`),
    position: normalizeVec3(source.position, `connection ${connectionId}.${side}.position`),
    fallbackAnchorId: source.fallbackAnchorId == null ? null : assertSpatialId(source.fallbackAnchorId, `connection ${connectionId}.${side}.fallbackAnchorId`),
  });
}

function normalizeConnection(value, locationId) {
  const source = requireObject(value, `connection in ${locationId}`);
  const id = assertSpatialId(source.id, `connection id in ${locationId}`);
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new SpatialContractError(`connection ${id} needs a user-facing label`, {locationId, id});
  const kind = String(source.kind || "passage");
  if (!CONNECTION_KINDS.has(kind)) throw new SpatialContractError(`connection ${id} has unsupported kind ${kind}`, {id, kind});
  const traversal = requireObject(source.traversal || {}, `connection ${id}.traversal`);
  const mode = String(traversal.mode || "instant");
  if (!TRAVERSAL_MODES.has(mode)) throw new SpatialContractError(`connection ${id} has unsupported traversal mode ${mode}`, {id, mode});
  const duration = traversal.duration == null ? 0 : finite(traversal.duration, `connection ${id}.traversal.duration`);
  if (duration < 0) throw new SpatialContractError(`connection ${id}.traversal.duration must be non-negative`, {id});
  const states = Object.freeze([...(source.states || ["open", "closed", "locked", "blocked", "destroyed"])].map(state => assertSpatialId(state, `connection ${id}.state`)));
  const initialState = assertSpatialId(source.initialState || ((kind === "door" || kind === "hatch" || kind === "lift") ? "closed" : "open"), `connection ${id}.initialState`);
  const passableStates = Object.freeze([...(source.passableStates || ["open", "destroyed"])].map(state => assertSpatialId(state, `connection ${id}.passableState`)));
  if (!states.includes(initialState)) throw new SpatialContractError(`connection ${id} initial state is not declared`, {id, initialState});
  for (const state of passableStates) if (!states.includes(state)) throw new SpatialContractError(`connection ${id} passable state ${state} is not declared`, {id, state});
  const acousticTransmission = Object.freeze({
    open: source.acousticTransmission?.open == null ? 1 : finite(source.acousticTransmission.open, `connection ${id}.acousticTransmission.open`),
    closed: source.acousticTransmission?.closed == null ? 0.18 : finite(source.acousticTransmission.closed, `connection ${id}.acousticTransmission.closed`),
  });
  for (const [state, value] of Object.entries(acousticTransmission)) if (value < 0 || value > 1) throw new SpatialContractError(`connection ${id} acoustic transmission ${state} must be 0..1`, {id, state, value});
  return Object.freeze({
    ...cloneSpatialData(source),
    id,
    label,
    kind,
    presentation: normalizePresentation(source.presentation, label, `connection ${id}.presentation`),
    from: normalizeEndpoint(source.from, id, "from"),
    to: normalizeEndpoint(source.to, id, "to"),
    bidirectional: source.bidirectional !== false,
    states,
    initialState,
    passableStates,
    traversal: Object.freeze({...cloneSpatialData(traversal), mode, duration}),
    cost: source.cost == null ? 1 : finite(source.cost, `connection ${id}.cost`),
    acousticTransmission,
  });
}

function normalizeModule(value, locationId) {
  const source = requireObject(value, `module in ${locationId}`);
  const id = assertSpatialId(source.id, `module id in ${locationId}`);
  const type = assertSpatialId(source.type, `module ${id}.type`);
  return Object.freeze({...cloneSpatialData(source), id, type, optional: source.optional === true, config: Object.freeze(cloneSpatialData(source.config || {}))});
}

function normalizeSpawn(value, locationId) {
  const source = requireObject(value, `spawn in ${locationId}`);
  const id = assertSpatialId(source.id, `spawn id in ${locationId}`);
  const spaceId = assertSpatialId(source.spaceId, `spawn ${id}.spaceId`);
  const anchorId = source.anchorId == null ? null : assertSpatialId(source.anchorId, `spawn ${id}.anchorId`);
  const position = source.position == null ? null : normalizeVec3(source.position, `spawn ${id}.position`);
  if (!anchorId && !position) throw new SpatialContractError(`spawn ${id} needs anchorId or position`, {id});
  return Object.freeze({...cloneSpatialData(source), id, spaceId, anchorId, position, mode: String(source.mode || "foot")});
}

function normalizeCompatibilityWarning(value, locationId) {
  const source = requireObject(value, `compatibility warning in ${locationId}`);
  const code = assertSpatialId(source.code, `compatibility warning code in ${locationId}`);
  const legacySystem = assertSpatialId(source.legacySystem, `compatibility ${code}.legacySystem`);
  const replacement = assertSpatialId(source.replacement, `compatibility ${code}.replacement`);
  const targetId = source.targetId == null ? null : assertSpatialId(source.targetId, `compatibility ${code}.targetId`);
  const message = String(source.message || "").trim();
  if (!message) throw new SpatialContractError(`compatibility warning ${code} needs message`, {code});
  return Object.freeze({...cloneSpatialData(source), code, legacySystem, replacement, targetId, message});
}

function ensureUnique(entries, kind) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new SpatialContractError(`duplicate ${kind} id ${entry.id}`, {kind, id: entry.id});
    seen.add(entry.id);
  }
}

function pointInPolygon2d(point, polygon) {
  let inside = false;
  const points = polygon.outer;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    const onBoundary = Math.abs(cross) <= 1e-9 && point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9 && point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9;
    if (onBoundary) return true;
    const intersects = ((a.y > point.y) !== (b.y > point.y)) && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function assertPointInsideSpace(point, space, field) {
  if (point.z < space.shape.minZ - 1e-6 || point.z > space.shape.maxZ + 1e-6 || !pointInPolygon2d(point, space.shape)) {
    throw new SpatialContractError(`${field} is outside space ${space.id}`, {field, spaceId: space.id, point});
  }
}

function validateParentGraph(spacesById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new SpatialContractError(`space parent cycle detected at ${id}`, {spaceId: id});
    visiting.add(id);
    const parentId = spacesById.get(id).parentSpaceId;
    if (parentId != null) {
      if (!spacesById.has(parentId)) throw new SpatialContractError(`space ${id} references missing parent ${parentId}`, {spaceId: id, parentId});
      visit(parentId);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of spacesById.keys()) visit(id);
}

export function normalizeLocationDefinition(definition) {
  const source = requireObject(definition, "location definition");
  const schemaVersion = source.schemaVersion == null ? SPATIAL_SCHEMA_VERSION : Number(source.schemaVersion);
  if (schemaVersion !== SPATIAL_SCHEMA_VERSION) throw new SpatialContractError(`unsupported spatial schema version ${schemaVersion}`, {schemaVersion});
  const id = assertSpatialId(source.id, "location id");
  const label = String(source.label || source.presentation?.label || "").trim();
  if (!label) throw new SpatialContractError(`location ${id} needs a user-facing label`, {id});
  const worldTransform = normalizeTransform(source.worldTransform || {}, `location ${id}.worldTransform`);
  const presentation = normalizePresentation(source.presentation, label, `location ${id}.presentation`);
  const spaces = Object.freeze([...(source.spaces || [])].map(space => normalizeSpace(space, id)));
  if (!spaces.length) throw new SpatialContractError(`location ${id} needs at least one space`, {id});
  const connections = Object.freeze([...(source.connections || [])].map(connection => normalizeConnection(connection, id)));
  const modules = Object.freeze([...(source.modules || [])].map(module => normalizeModule(module, id)));
  const spawns = Object.freeze([...(source.spawns || [])].map(spawn => normalizeSpawn(spawn, id)));
  if (!spawns.length) throw new SpatialContractError(`location ${id} needs at least one spawn`, {id});
  const compatibility = Object.freeze([...(source.compatibility || [])].map(entry => normalizeCompatibilityWarning(entry, id)));

  ensureUnique(spaces, "space");
  ensureUnique(connections, "connection");
  ensureUnique(modules, "module");
  ensureUnique(spawns, "spawn");

  const spacesById = new Map(spaces.map(space => [space.id, space]));
  validateParentGraph(spacesById);

  const anchorIds = new Set();
  const objectIds = new Set();
  for (const space of spaces) {
    for (const anchor of space.anchors) {
      if (anchorIds.has(anchor.id)) throw new SpatialContractError(`duplicate anchor id ${anchor.id}`, {id: anchor.id});
      anchorIds.add(anchor.id);
      assertPointInsideSpace(anchor.position, space, `anchor ${anchor.id}.position`);
    }
    for (const object of space.objects) {
      if (objectIds.has(object.id)) throw new SpatialContractError(`duplicate object id ${object.id}`, {id: object.id});
      objectIds.add(object.id);
      assertPointInsideSpace(object.position, space, `object ${object.id}.position`);
    }
  }

  for (const connection of connections) {
    const fromSpace = spacesById.get(connection.from.spaceId);
    const toSpace = spacesById.get(connection.to.spaceId);
    if (!fromSpace) throw new SpatialContractError(`connection ${connection.id} references missing from space ${connection.from.spaceId}`, {connectionId: connection.id});
    if (!toSpace) throw new SpatialContractError(`connection ${connection.id} references missing to space ${connection.to.spaceId}`, {connectionId: connection.id});
    assertPointInsideSpace(connection.from.position, fromSpace, `connection ${connection.id}.from.position`);
    assertPointInsideSpace(connection.to.position, toSpace, `connection ${connection.id}.to.position`);
    if (connection.from.fallbackAnchorId && !anchorIds.has(connection.from.fallbackAnchorId)) throw new SpatialContractError(`connection ${connection.id} references missing fallback anchor ${connection.from.fallbackAnchorId}`, {connectionId: connection.id});
    if (connection.to.fallbackAnchorId && !anchorIds.has(connection.to.fallbackAnchorId)) throw new SpatialContractError(`connection ${connection.id} references missing fallback anchor ${connection.to.fallbackAnchorId}`, {connectionId: connection.id});
  }

  for (const spawn of spawns) {
    const space = spacesById.get(spawn.spaceId);
    if (!space) throw new SpatialContractError(`spawn ${spawn.id} references missing space ${spawn.spaceId}`, {spawnId: spawn.id});
    if (spawn.anchorId && !anchorIds.has(spawn.anchorId)) throw new SpatialContractError(`spawn ${spawn.id} references missing anchor ${spawn.anchorId}`, {spawnId: spawn.id});
    if (spawn.anchorId) {
      const owner = spaces.find(entry => entry.anchors.some(anchor => anchor.id === spawn.anchorId));
      if (owner?.id !== spawn.spaceId) throw new SpatialContractError(`spawn ${spawn.id} anchor ${spawn.anchorId} belongs to another space`, {spawnId: spawn.id});
    }
    if (spawn.position) assertPointInsideSpace(spawn.position, space, `spawn ${spawn.id}.position`);
  }

  return Object.freeze({
    ...cloneSpatialData(source),
    schemaVersion,
    id,
    label,
    presentation,
    worldTransform,
    spaces,
    connections,
    modules,
    spawns,
    compatibility,
    persistence: Object.freeze({version: Number(source.persistence?.version || 1)}),
  });
}
