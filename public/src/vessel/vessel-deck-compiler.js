"use strict";

import {VesselContractError, assertId, assertPlainObject, cloneData, isPlainObject, normalizePoint} from "./vessel-contract.js";

export const DECK_ARCHITECTURE_VERSION = 1;

const EPSILON = 1e-7;
const DEFAULT_MOVEMENT = Object.freeze({speed: 1, jumpDistance: 1.8, runJumpMultiplier: 1.65});
const DEFAULT_ACOUSTICS = Object.freeze({mode: "automatic", transmission: 1, transitionMs: 180});
const DEFAULT_RECONNECT = Object.freeze({mode: "last-valid-or-safe"});
const DEFAULT_BOARDING = Object.freeze({mode: "direct-control", points: Object.freeze([])});
const DEFAULT_CONTROL = Object.freeze({mode: "direct"});
const DEFAULT_AUDIO = Object.freeze({footsteps: "default", jump: "default"});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback, field) {
  const number = finite(value, fallback);
  if (!(number > 0)) throw new VesselContractError(`${field} must be greater than zero`, {field, value});
  return number;
}

function nonNegative(value, fallback, field) {
  const number = finite(value, fallback);
  if (number < 0) throw new VesselContractError(`${field} must be non-negative`, {field, value});
  return number;
}

function between01(value, fallback, field) {
  const number = finite(value, fallback);
  if (number < 0 || number > 1) throw new VesselContractError(`${field} must be between 0 and 1`, {field, value});
  return number;
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + EPSILON
    && b.x + EPSILON >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) + EPSILON
    && b.y + EPSILON >= Math.min(a.y, c.y);
}

export function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

export function polygonArea(points = []) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return area / 2;
}

function pointOnBoundary(point, polygon) {
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (orientation(a, point, b) === 0 && onSegment(a, point, b)) return true;
  }
  return false;
}

export function pointInRing(point, polygon = []) {
  if (!polygon.length) return false;
  if (pointOnBoundary(point, polygon)) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInShape(point, shape) {
  if (!shape?.outer || !pointInRing(point, shape.outer)) return false;
  return !(shape.holes || []).some(hole => pointInRing(point, hole));
}
function samePoint(a, b) {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function boundaryEdges(shape) {
  const rings = [shape.outer, ...(shape.holes || [])];
  const edges = [];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) edges.push([ring[index], ring[(index + 1) % ring.length]]);
  }
  return edges;
}

function segmentWalkable(shape, a, b) {
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const point = {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
    if (!pointInShape(point, shape)) return false;
  }
  for (const [c, d] of boundaryEdges(shape)) {
    if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) continue;
    if (segmentsIntersect(a, b, c, d)) return false;
  }
  return true;
}

export function findPathInShape(shape, start, target) {
  if (!pointInShape(start, shape) || !pointInShape(target, shape)) return null;
  if (segmentWalkable(shape, start, target)) return Object.freeze([Object.freeze({...start}), Object.freeze({...target})]);
  const nodes = [start, target, ...shape.outer, ...(shape.holes || []).flat()];
  const graph = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (!segmentWalkable(shape, nodes[i], nodes[j])) continue;
      const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      graph[i].push([j, distance]);
      graph[j].push([i, distance]);
    }
  }
  const distance = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const used = nodes.map(() => false);
  distance[0] = 0;
  for (;;) {
    let current = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (!used[index] && (current < 0 || distance[index] < distance[current])) current = index;
    }
    if (current < 0 || !Number.isFinite(distance[current])) break;
    if (current === 1) break;
    used[current] = true;
    for (const [next, cost] of graph[current]) {
      const candidate = distance[current] + cost;
      if (candidate >= distance[next]) continue;
      distance[next] = candidate;
      previous[next] = current;
    }
  }
  if (!Number.isFinite(distance[1])) return null;
  const indices = [];
  for (let current = 1; current >= 0; current = previous[current]) {
    indices.push(current);
    if (current === 0) break;
  }
  indices.reverse();
  return Object.freeze(indices.map(index => Object.freeze({...nodes[index]})));
}

function assertSimpleRing(points, field) {
  if (Math.abs(polygonArea(points)) < EPSILON) throw new VesselContractError(`${field} has zero area`);
  const count = points.length;
  for (let left = 0; left < count; left += 1) {
    const a = points[left];
    const b = points[(left + 1) % count];
    for (let right = left + 1; right < count; right += 1) {
      if (right === left || right === (left + 1) % count || (right + 1) % count === left) continue;
      const c = points[right];
      const d = points[(right + 1) % count];
      if (segmentsIntersect(a, b, c, d)) throw new VesselContractError(`${field} self-intersects`, {left, right});
    }
  }
}

function assertShape(shape, field) {
  assertSimpleRing(shape.outer, `${field}.outer`);
  for (let index = 0; index < (shape.holes || []).length; index += 1) {
    const hole = shape.holes[index];
    assertSimpleRing(hole, `${field}.holes[${index}]`);
    for (const point of hole) if (!pointInRing(point, shape.outer)) throw new VesselContractError(`${field}.holes[${index}] escapes outer boundary`);
  }
}

function assertPointInside(point, shape, field) {
  if (!pointInShape(point, shape)) throw new VesselContractError(`${field} lies outside its walkable shape`, {point});
}

function normalizeMovement(value, field, inherited = DEFAULT_MOVEMENT) {
  const source = value == null ? {} : assertPlainObject(value, field);
  return Object.freeze({...cloneData(inherited), ...cloneData(source), speed: positive(source.speed, inherited.speed, `${field}.speed`), jumpDistance: nonNegative(source.jumpDistance, inherited.jumpDistance, `${field}.jumpDistance`), runJumpMultiplier: positive(source.runJumpMultiplier, inherited.runJumpMultiplier, `${field}.runJumpMultiplier`)});
}

function normalizeAcoustics(value, field, inherited = DEFAULT_ACOUSTICS) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || inherited.mode || "automatic");
  if (!["automatic", "semi-auto", "manual"].includes(mode)) throw new VesselContractError(`${field}.mode must be automatic, semi-auto or manual`, {mode});
  return Object.freeze({...cloneData(inherited), ...cloneData(source), mode, transmission: between01(source.transmission, inherited.transmission, `${field}.transmission`), transitionMs: nonNegative(source.transitionMs, inherited.transitionMs, `${field}.transitionMs`)});
}

function normalizeWater(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  return Object.freeze({...cloneData(source), enabled: source.enabled === true, maxDepth: positive(source.maxDepth, 2, `${field}.maxDepth`), swimDepth: positive(source.swimDepth, 1.1, `${field}.swimDepth`), fullDamagePerSecond: nonNegative(source.fullDamagePerSecond, 0, `${field}.fullDamagePerSecond`), underwaterAcoustics: Object.freeze(cloneData(source.underwaterAcoustics || {}))});
}

function normalizeInertia(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || "stable");
  if (!["stable", "physical"].includes(mode)) throw new VesselContractError(`${field}.mode must be stable or physical`);
  return Object.freeze({...cloneData(source), mode, scale: nonNegative(source.scale, 1, `${field}.scale`), fallThreshold: nonNegative(source.fallThreshold, 0, `${field}.fallThreshold`), overboardThreshold: nonNegative(source.overboardThreshold, 0, `${field}.overboardThreshold`)});
}

function normalizeControl(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || DEFAULT_CONTROL.mode);
  if (!["direct", "stations"].includes(mode)) throw new VesselContractError(`${field}.mode must be direct or stations`);
  return Object.freeze({...cloneData(source), mode});
}

function normalizeAudio(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  return Object.freeze({...cloneData(DEFAULT_AUDIO), ...cloneData(source), footsteps: String(source.footsteps || DEFAULT_AUDIO.footsteps), jump: String(source.jump || DEFAULT_AUDIO.jump)});
}

function normalizeAnnouncement(value, field) {
  if (value == null) return Object.freeze({mode: "zone-change"});
  if (typeof value === "string") value = {mode: value};
  const source = assertPlainObject(value, field);
  const mode = String(source.mode || "zone-change");
  if (!["every-entry", "first-entry", "entry-exit", "zone-change", "silent"].includes(mode)) throw new VesselContractError(`${field}.mode is invalid`, {mode});
  return Object.freeze({...cloneData(source), mode});
}

function normalizeBoarding(value, definition, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || DEFAULT_BOARDING.mode);
  if (!["direct-control", "deck-entry"].includes(mode)) throw new VesselContractError(`${field}.mode must be direct-control or deck-entry`);
  const deckById = new Map((definition.decks || []).map(deck => [deck.id, deck]));
  const points = Object.freeze([...(source.points || [])].map((entry, index) => {
    const point = assertPlainObject(entry, `${field}.points[${index}]`);
    const id = assertId(point.id, `${field}.points[${index}].id`);
    const deckId = assertId(point.deckId, `${field}.points[${index}].deckId`);
    const deck = deckById.get(deckId);
    if (!deck) throw new VesselContractError(`boarding point ${id} references missing deck ${deckId}`);
    const position = normalizePoint(point.position, `boarding point ${id} position`);
    assertPointInside(position, deck.shape, `boarding point ${id}`);
    return Object.freeze({...cloneData(point), id, deckId, position, safe: point.safe !== false});
  }));
  if (mode === "deck-entry" && !points.length) throw new VesselContractError(`${field}.points needs at least one entry for deck-entry mode`);
  return Object.freeze({...cloneData(source), mode, points});
}

function normalizeReconnect(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || DEFAULT_RECONNECT.mode);
  if (!["last-valid", "safe-point", "last-valid-or-safe"].includes(mode)) throw new VesselContractError(`${field}.mode is invalid`, {mode});
  return Object.freeze({...cloneData(source), mode});
}

function normalizeSinking(value, field) {
  const source = value == null ? {} : assertPlainObject(value, field);
  const mode = String(source.mode || "simple");
  if (!["simple", "emergency-phase"].includes(mode)) throw new VesselContractError(`${field}.mode must be simple or emergency-phase`);
  return Object.freeze({...cloneData(source), mode, emergencyDuration: nonNegative(source.emergencyDuration, 0, `${field}.emergencyDuration`), geometryTilt: source.geometryTilt === true});
}

function entityKey(kind, deckId, id) { return `${kind}:${deckId}:${id}`; }

function normalizeRuleInstances(value, field, registry, owner) {
  const source = value == null ? [] : value;
  if (!Array.isArray(source)) throw new VesselContractError(`${field} must be an array`);
  const seen = new Set();
  return Object.freeze(source.map((entry, index) => {
    const rule = assertPlainObject(entry, `${field}[${index}]`);
    const id = assertId(rule.id, `${field}[${index}].id`);
    if (seen.has(id)) throw new VesselContractError(`${field} contains duplicate rule id ${id}`);
    seen.add(id);
    const type = assertId(rule.type, `${field}[${index}].type`);
    const ruleType = registry?.resolveDeckRuleType?.(type);
    if (!ruleType) throw new VesselContractError(`${owner} references unregistered deck rule type ${type}`);
    const config = cloneData(rule.config || {});
    ruleType.validateConfig?.(config, {owner, ruleId: id});
    return Object.freeze({...cloneData(rule), id, type, config: Object.freeze(config)});
  }));
}

function resolveConnectionLanding(deckById, sourceDeck, connection) {
  const target = deckById.get(connection.toDeckId);
  if (!target) return null;
  if (connection.to) return {deckId: target.id, point: connection.to};
  const candidates = target.connections.filter(candidate => candidate.toDeckId === sourceDeck.id);
  if (connection.reverseId) {
    const reverse = candidates.find(candidate => candidate.id === connection.reverseId);
    if (!reverse) throw new VesselContractError(`connection ${connection.id} reverseId ${connection.reverseId} was not found on ${target.id}`);
    return {deckId: target.id, point: reverse.from, reverseId: reverse.id};
  }
  if (candidates.length === 1) return {deckId: target.id, point: candidates[0].from, reverseId: candidates[0].id};
  if (!candidates.length) return null;
  throw new VesselContractError(`connection ${connection.id} has ambiguous landing on ${target.id}; set to or reverseId`);
}

function shapeCentroid(shape) {
  const points = shape?.outer || [];
  if (!points.length) return null;
  const center = points.reduce((sum, point) => ({x: sum.x + point.x / points.length, y: sum.y + point.y / points.length}), {x: 0, y: 0});
  if (pointInShape(center, shape)) return center;
  return {...points[0]};
}

function assertNavigationReachability(definition, boarding) {
  if (!definition?.capabilities?.walkableInterior) return;
  for (const deck of definition.decks || []) {
    const anchors = [];
    for (const point of boarding.points || []) if (point.deckId === deck.id) anchors.push(point.position);
    for (const connection of deck.connections || []) anchors.push(connection.from);
    if (!anchors.length) { const fallback = shapeCentroid(deck.shape); if (fallback) anchors.push(fallback); }
    const targets = [];
    for (const landmark of deck.landmarks || []) if (landmark.navigation !== false) targets.push({kind: "landmark", id: landmark.id, point: landmark.position});
    for (const object of deck.objects || []) if (object.navigation !== false) targets.push({kind: "object", id: object.id, point: object.position});
    for (const zone of deck.zones || []) {
      if (zone.navigation === false || !zone.shape) continue;
      const point = shapeCentroid(zone.shape);
      if (point) targets.push({kind: "zone", id: zone.id, point});
    }
    for (const target of targets) {
      if (!anchors.some(anchor => findPathInShape(deck.shape, anchor, target.point))) throw new VesselContractError(`${target.kind} ${target.id} is declared navigable but is unreachable on deck ${deck.id}`, {deckId: deck.id, target});
    }
  }
}

function connectedDecks(definition) {
  const graph = new Map((definition.decks || []).map(deck => [deck.id, new Set()]));
  for (const deck of definition.decks || []) for (const connection of deck.connections || []) { graph.get(deck.id)?.add(connection.toDeckId); graph.get(connection.toDeckId)?.add(deck.id); }
  return graph;
}

function assertWalkableConnectivity(definition, boarding) {
  if (!definition?.capabilities?.walkableInterior || (definition.decks || []).length <= 1) return;
  const graph = connectedDecks(definition);
  const roots = boarding.mode === "deck-entry" && boarding.points.length ? [...new Set(boarding.points.map(point => point.deckId))] : [definition.decks[0].id];
  const visited = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const deckId = queue.shift();
    for (const next of graph.get(deckId) || []) { if (visited.has(next)) continue; visited.add(next); queue.push(next); }
  }
  const missing = definition.decks.map(deck => deck.id).filter(id => !visited.has(id));
  if (missing.length) throw new VesselContractError(`walkable vessel ${definition.id} has unreachable decks: ${missing.join(", ")}`, {missing});
}

function validateGeometry(definition) {
  const globalIds = new Map();
  const deckById = new Map((definition.decks || []).map(deck => [deck.id, deck]));
  for (const deck of definition.decks || []) {
    assertShape(deck.shape, `deck ${deck.id} shape`);
    const register = (kind, id) => { const previous = globalIds.get(id); if (previous) throw new VesselContractError(`deck entity id ${id} is duplicated by ${previous} and ${kind}`); globalIds.set(id, kind); };
    register("deck", deck.id);
    for (const zone of deck.zones || []) {
      register("zone", zone.id);
      if (zone.shape) { assertShape(zone.shape, `zone ${zone.id} shape`); for (const point of zone.shape.outer) assertPointInside(point, deck.shape, `zone ${zone.id}`); }
    }
    for (const landmark of deck.landmarks || []) {
      register("landmark", landmark.id); assertPointInside(landmark.position, deck.shape, `landmark ${landmark.id}`);
      if (landmark.zoneId) { const zone = deck.zones.find(item => item.id === landmark.zoneId); if (zone?.shape) assertPointInside(landmark.position, zone.shape, `landmark ${landmark.id} in zone ${zone.id}`); }
    }
    for (const object of deck.objects || []) {
      register("object", object.id); assertPointInside(object.position, deck.shape, `object ${object.id}`);
      if (object.zoneId) { const zone = deck.zones.find(item => item.id === object.zoneId); if (zone?.shape) assertPointInside(object.position, zone.shape, `object ${object.id} in zone ${zone.id}`); }
    }
    for (const connection of deck.connections || []) {
      register("connection", connection.id); assertPointInside(connection.from, deck.shape, `connection ${connection.id} source`);
      const target = deckById.get(connection.toDeckId);
      if (!target) throw new VesselContractError(`connection ${connection.id} references missing deck ${connection.toDeckId}`);
      const landing = resolveConnectionLanding(deckById, deck, connection);
      if (connection.to) assertPointInside(connection.to, target.shape, `connection ${connection.id} target`);
      if (landing?.point) assertPointInside(landing.point, target.shape, `connection ${connection.id} landing`);
      if (connection.reverseId) {
        const reverse = (target.connections || []).find(item => item.id === connection.reverseId);
        if (!reverse) throw new VesselContractError(`connection ${connection.id} reverseId ${connection.reverseId} was not found`);
        if (reverse.toDeckId !== deck.id) throw new VesselContractError(`connection ${connection.id} reverse ${reverse.id} does not lead back to ${deck.id}`);
        if (reverse.reverseId && reverse.reverseId !== connection.id) throw new VesselContractError(`connection ${connection.id} and ${reverse.id} disagree about reverseId`);
        if (reverse.initialState !== connection.initialState) throw new VesselContractError(`connection ${connection.id} and reverse ${reverse.id} need the same initialState`);
      }
    }
  }
}

function validateEntityPolicies(definition) {
  for (const deck of definition.decks || []) {
    for (const object of deck.objects || []) {
      const buoyancy = object.buoyancy == null ? "fixed" : String(object.buoyancy);
      if (!["float", "sink", "fixed"].includes(buoyancy)) throw new VesselContractError(`object ${object.id} buoyancy must be float, sink or fixed`, {buoyancy});
      if (object.interactionRange != null) nonNegative(object.interactionRange, 0, `object ${object.id}.interactionRange`);
      if (object.health != null) nonNegative(object.health, 0, `object ${object.id}.health`);
    }
    for (const connection of deck.connections || []) {
      if (connection.interactionRange != null) nonNegative(connection.interactionRange, 0, `connection ${connection.id}.interactionRange`);
      if (connection.health != null) nonNegative(connection.health, 0, `connection ${connection.id}.health`);
      if (connection.water != null) {
        const water = assertPlainObject(connection.water, `connection ${connection.id}.water`);
        if (water.watertight != null && typeof water.watertight !== "boolean") throw new VesselContractError(`connection ${connection.id}.water.watertight must be boolean`);
        nonNegative(water.flowRate, 0, `connection ${connection.id}.water.flowRate`);
      }
      if (connection.acoustics != null) {
        const acoustics = assertPlainObject(connection.acoustics, `connection ${connection.id}.acoustics`);
        if (acoustics.openTransmission != null) between01(acoustics.openTransmission, 1, `connection ${connection.id}.acoustics.openTransmission`);
        if (acoustics.closedTransmission != null) between01(acoustics.closedTransmission, 0, `connection ${connection.id}.acoustics.closedTransmission`);
      }
    }
  }
}

function compileEntities(definition, registry, movementDefaults, acousticDefaults) {
  const entities = new Map(); const ruleOwners = [];
  for (const deck of definition.decks || []) {
    const deckMovement = normalizeMovement(deck.movement, `deck ${deck.id} movement`, movementDefaults);
    const deckAcoustics = normalizeAcoustics(deck.acoustics, `deck ${deck.id} acoustics`, acousticDefaults);
    const deckRules = normalizeRuleInstances(deck.rules, `deck ${deck.id} rules`, registry, `deck ${deck.id}`);
    entities.set(entityKey("deck", deck.id, deck.id), Object.freeze({kind: "deck", deckId: deck.id, id: deck.id, movement: deckMovement, acoustics: deckAcoustics, rules: deckRules})); ruleOwners.push({owner: `deck:${deck.id}`, rules: deckRules});
    for (const zone of deck.zones || []) {
      const movement = normalizeMovement(zone.movement, `zone ${zone.id} movement`, deckMovement); const acoustics = normalizeAcoustics(zone.acoustics, `zone ${zone.id} acoustics`, deckAcoustics); const water = normalizeWater(zone.water, `zone ${zone.id} water`); const announcement = normalizeAnnouncement(zone.announcement, `zone ${zone.id} announcement`); const rules = normalizeRuleInstances(zone.rules, `zone ${zone.id} rules`, registry, `zone ${zone.id}`);
      entities.set(entityKey("zone", deck.id, zone.id), Object.freeze({kind: "zone", deckId: deck.id, id: zone.id, movement, acoustics, water, announcement, rules})); ruleOwners.push({owner: `zone:${zone.id}`, rules});
    }
    for (const object of deck.objects || []) { const rules = normalizeRuleInstances(object.rules, `object ${object.id} rules`, registry, `object ${object.id}`); entities.set(entityKey("object", deck.id, object.id), Object.freeze({kind: "object", deckId: deck.id, id: object.id, rules})); ruleOwners.push({owner: `object:${object.id}`, rules}); }
    for (const connection of deck.connections || []) { const rules = normalizeRuleInstances(connection.rules, `connection ${connection.id} rules`, registry, `connection ${connection.id}`); entities.set(entityKey("connection", deck.id, connection.id), Object.freeze({kind: "connection", deckId: deck.id, id: connection.id, rules})); ruleOwners.push({owner: `connection:${connection.id}`, rules}); }
  }
  return {entities, ruleOwners};
}

export function compileVesselDeckArchitecture(definition, registry = null) {
  const decks = definition?.decks || [];
  const source = isPlainObject(definition?.deckArchitecture) ? definition.deckArchitecture : {};
  const enabled = definition?.capabilities?.walkableInterior === true || decks.length > 0 || source.enabled === true;
  const movement = normalizeMovement(source.movement, `vessel ${definition.id} deckArchitecture.movement`, DEFAULT_MOVEMENT);
  const acoustics = normalizeAcoustics(source.acoustics, `vessel ${definition.id} deckArchitecture.acoustics`, DEFAULT_ACOUSTICS);
  validateGeometry(definition); validateEntityPolicies(definition);
  const boarding = normalizeBoarding(source.boarding, definition, `vessel ${definition.id} deckArchitecture.boarding`);
  const control = normalizeControl(source.control, `vessel ${definition.id} deckArchitecture.control`);
  const audio = normalizeAudio(source.audio, `vessel ${definition.id} deckArchitecture.audio`);
  const reconnect = normalizeReconnect(source.reconnect, `vessel ${definition.id} deckArchitecture.reconnect`);
  const sinking = normalizeSinking(source.sinking, `vessel ${definition.id} deckArchitecture.sinking`);
  const playerInertia = normalizeInertia(source.playerInertia, `vessel ${definition.id} deckArchitecture.playerInertia`);
  const cargoInertia = normalizeInertia(source.cargoInertia, `vessel ${definition.id} deckArchitecture.cargoInertia`);
  if (definition?.capabilities?.walkableInterior && !decks.length) throw new VesselContractError(`walkable vessel ${definition.id} needs at least one deck`);
  assertWalkableConnectivity(definition, boarding); assertNavigationReachability(definition, boarding);
  if (control.mode === "stations" && !decks.some(deck => (deck.objects || []).some(object => object.kind === "station"))) throw new VesselContractError(`vessel ${definition.id} uses station control but declares no deck object with kind station`);
  const {entities, ruleOwners} = compileEntities(definition, registry, movement, acoustics);
  return Object.freeze({...cloneData(source), version: DECK_ARCHITECTURE_VERSION, enabled, movement, acoustics, boarding, control, audio, reconnect, sinking, playerInertia, cargoInertia, entities, ruleOwners: Object.freeze(ruleOwners.map(entry => Object.freeze(entry)))});
}
