"use strict";

import {VesselContractError, assertId, cloneData} from "./vessel-contract.js";
import {pointInShape} from "./vessel-deck-compiler.js";

export const VESSEL_DECK_RUNTIME_VERSION = 1;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const wrap = value => ((Number(value || 0) + 180) % 360 + 360) % 360 - 180;

function deckFor(definition, deckId) {
  return (definition?.decks || []).find(deck => deck.id === deckId) || null;
}

function zoneFor(deck, zoneId) {
  return (deck?.zones || []).find(zone => zone.id === zoneId) || null;
}

function connectionFor(definition, connectionId) {
  for (const deck of definition?.decks || []) {
    const connection = (deck.connections || []).find(item => item.id === connectionId);
    if (connection) return {deck, connection};
  }
  return null;
}

function objectFor(definition, objectId) {
  for (const deck of definition?.decks || []) {
    const object = (deck.objects || []).find(item => item.id === objectId);
    if (object) return {deck, object};
  }
  return null;
}

function compiledZone(definition, deckId, zoneId) {
  return definition?.deckArchitecture?.entities?.get?.(`zone:${deckId}:${zoneId}`) || null;
}

function zoneAnnouncementEvents(definition, instance, playerIndex, deckId, previousZoneId, nextZoneId) {
  if (previousZoneId === nextZoneId) return [];
  const interior = ensureInterior(instance);
  const events = [];
  const keyPrefix = `${playerIndex}:`;
  if (previousZoneId) {
    const previous = zoneFor(deckFor(definition, deckId), previousZoneId);
    const mode = compiledZone(definition, deckId, previousZoneId)?.announcement?.mode || "zone-change";
    if (previous && mode === "entry-exit") events.push({kind: "zone-exit", zoneId: previousZoneId, label: previous.label});
  }
  if (nextZoneId) {
    const next = zoneFor(deckFor(definition, deckId), nextZoneId);
    const mode = compiledZone(definition, deckId, nextZoneId)?.announcement?.mode || "zone-change";
    const marker = `${keyPrefix}${nextZoneId}`;
    const seen = interior.announcements[marker] === true;
    const announce = mode === "every-entry" || mode === "entry-exit" || mode === "zone-change" || (mode === "first-entry" && !seen);
    if (announce && next) events.push({kind: "zone-enter", zoneId: nextZoneId, label: next.label});
    if (mode !== "silent") interior.announcements[marker] = true;
  }
  return events;
}

function occupantKey(playerIndex) {
  if (!Number.isInteger(playerIndex) || playerIndex < 0) throw new VesselContractError("playerIndex must be a non-negative integer");
  return String(playerIndex);
}

function ensureInterior(instance) {
  instance.interior ||= {
    version: VESSEL_DECK_RUNTIME_VERSION,
    connections: {},
    objects: {},
    rules: {},
    claims: {},
    traversals: {},
    announcements: {},
    emergency: null,
  };
  instance.interior.version = VESSEL_DECK_RUNTIME_VERSION;
  instance.interior.connections ||= {};
  instance.interior.objects ||= {};
  instance.interior.rules ||= {};
  instance.interior.claims ||= {};
  instance.interior.traversals ||= {};
  instance.interior.announcements ||= {};
  instance.zones ||= {};
  instance.occupants ||= {};
  return instance.interior;
}

function connectionDefaults(connection) {
  const states = connection.states || ["open", "closed", "locked", "jammed", "destroyed", "blocked"];
  const initialState = connection.initialState || (connection.kind === "ladder" || connection.kind === "jump" ? "open" : "closed");
  return {
    state: initialState,
    health: Number.isFinite(Number(connection.health)) ? Math.max(0, Number(connection.health)) : 100,
    enabled: true,
    states: [...states],
  };
}

function objectDefaults(object) {
  return {
    enabled: object.enabled !== false,
    health: Number.isFinite(Number(object.health)) ? Math.max(0, Number(object.health)) : 100,
    fixed: object.fixed === true,
    ...cloneData(object.initialState || {}),
  };
}

function ruleRuntimeKey(owner, ruleId) {
  return `${owner}/${ruleId}`;
}

export function initializeVesselDeckRuntime(registry, definition, instance, persisted = null) {
  if (!definition || !instance) throw new VesselContractError("deck runtime initialization needs definition and instance");
  const interior = ensureInterior(instance);
  for (const deck of definition.decks || []) {
    for (const zone of deck.zones || []) {
      const current = instance.zones[zone.id] || {};
      instance.zones[zone.id] = {
        health: Number.isFinite(Number(current.health)) ? Math.max(0, Number(current.health)) : 100,
        flooding: clamp(current.flooding, 0, 100),
        fire: clamp(current.fire, 0, 100),
        ...cloneData(current),
      };
    }
    for (const connection of deck.connections || []) interior.connections[connection.id] ||= connectionDefaults(connection);
    for (const object of deck.objects || []) interior.objects[object.id] ||= objectDefaults(object);
  }
  for (const owner of definition.deckArchitecture?.ruleOwners || []) {
    for (const rule of owner.rules || []) {
      const key = ruleRuntimeKey(owner.owner, rule.id);
      if (interior.rules[key]) continue;
      const ruleType = registry?.resolveDeckRuleType?.(rule.type);
      const state = ruleType?.createState ? ruleType.createState(rule.config, {definition, owner: owner.owner, rule}) : {};
      interior.rules[key] = cloneData(state || {});
    }
  }
  if (persisted) restoreVesselDeckPersistentState(registry, definition, instance, persisted);
  return interior;
}

export function resolveVesselZoneAt(definition, deckId, point) {
  const deck = deckFor(definition, deckId);
  if (!deck) return null;
  const shaped = (deck.zones || []).filter(zone => zone.shape && pointInShape(point, zone.shape));
  if (!shaped.length) return null;
  shaped.sort((a, b) => Math.abs(polygonSize(a.shape)) - Math.abs(polygonSize(b.shape)) || a.id.localeCompare(b.id));
  return shaped[0] || null;
}

function polygonSize(shape) {
  const points = shape?.outer || [];
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return area / 2;
}

export function validateVesselOccupantPosition(definition, position) {
  const deckId = assertId(position?.deckId, "occupant deckId");
  const deck = deckFor(definition, deckId);
  if (!deck) throw new VesselContractError(`unknown deck ${deckId}`);
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new VesselContractError("occupant local position needs finite x/y");
  if (!pointInShape({x, y}, deck.shape)) throw new VesselContractError(`occupant position lies outside deck ${deckId}`, {x, y, deckId});
  let zoneId = position?.zoneId == null ? null : assertId(position.zoneId, "occupant zoneId");
  if (zoneId) {
    const zone = zoneFor(deck, zoneId);
    if (!zone) throw new VesselContractError(`unknown zone ${zoneId} on deck ${deckId}`);
    if (zone.shape && !pointInShape({x, y}, zone.shape)) zoneId = resolveVesselZoneAt(definition, deckId, {x, y})?.id || null;
  } else zoneId = resolveVesselZoneAt(definition, deckId, {x, y})?.id || null;
  return Object.freeze({deckId, zoneId, x, y, heading: wrap(position?.heading || 0), mode: String(position?.mode || "walking")});
}

export function tryMoveVesselOccupant(definition, instance, playerIndex, delta, options = {}) {
  const key = occupantKey(playerIndex);
  const current = instance?.occupants?.[key];
  if (!current) throw new VesselContractError(`player ${playerIndex} has no vessel-local position`);
  const deck = deckFor(definition, current.deckId);
  if (!deck) throw new VesselContractError(`unknown deck ${current.deckId}`);
  const mode = String(options.mode || "walk");
  const next = {...current, x: Number(current.x) + Number(delta?.x || 0), y: Number(current.y) + Number(delta?.y || 0), heading: options.heading == null ? current.heading : wrap(options.heading)};
  if (!pointInShape(next, deck.shape)) return Object.freeze({moved: false, reason: mode === "jump" ? "no-valid-landing" : "deck-edge", edge: true, position: Object.freeze({...current})});
  const previousZone = current.zoneId || null;
  const nextZone = resolveVesselZoneAt(definition, current.deckId, next)?.id || null;
  next.zoneId = nextZone;
  instance.occupants[key] = next;
  const announcements = zoneAnnouncementEvents(definition, instance, playerIndex, current.deckId, previousZone, nextZone);
  return Object.freeze({moved: true, reason: "moved", position: Object.freeze({...next}), zoneChanged: previousZone !== nextZone, previousZoneId: previousZone, zoneId: nextZone, announcements: Object.freeze(announcements.map(event => Object.freeze(event)))});
}

export function connectionPassable(definition, instance, connectionId) {
  const found = connectionFor(definition, assertId(connectionId, "connection id"));
  if (!found) return false;
  const state = ensureInterior(instance).connections[found.connection.id] || connectionDefaults(found.connection);
  const passableStates = new Set(found.connection.passableStates || ["open", "destroyed"]);
  return state.enabled !== false && passableStates.has(String(state.state));
}

function reverseConnection(definition, sourceDeckId, connection) {
  const target = deckFor(definition, connection.toDeckId);
  if (!target) return null;
  if (connection.reverseId) return (target.connections || []).find(item => item.id === connection.reverseId) || null;
  const candidates = (target.connections || []).filter(item => item.toDeckId === sourceDeckId);
  return candidates.length === 1 ? candidates[0] : null;
}

export function setVesselConnectionState(definition, instance, connectionId, nextState) {
  const found = connectionFor(definition, assertId(connectionId, "connection id"));
  if (!found) throw new VesselContractError(`unknown connection ${connectionId}`);
  const interior = ensureInterior(instance);
  const current = interior.connections[found.connection.id] ||= connectionDefaults(found.connection);
  const state = assertId(nextState, `connection ${connectionId} state`);
  const allowed = new Set(found.connection.states || current.states || []);
  if (allowed.size && !allowed.has(state)) throw new VesselContractError(`connection ${connectionId} does not allow state ${state}`);
  const previousState = current.state;
  current.state = state;
  const reverse = reverseConnection(definition, found.deck.id, found.connection);
  if (reverse) {
    const reverseState = interior.connections[reverse.id] ||= connectionDefaults(reverse);
    const reverseAllowed = new Set(reverse.states || reverseState.states || []);
    if (reverseAllowed.has(state)) reverseState.state = state;
  }
  return Object.freeze({connectionId: found.connection.id, previousState, state, passable: connectionPassable(definition, instance, found.connection.id)});
}

export function vesselConnectionLanding(definition, sourceDeckId, connectionId) {
  const found = connectionFor(definition, assertId(connectionId, "connection id"));
  if (!found || found.deck.id !== sourceDeckId) return null;
  const targetDeck = deckFor(definition, found.connection.toDeckId);
  if (!targetDeck) return null;
  if (found.connection.to) return Object.freeze({deckId: targetDeck.id, x: found.connection.to.x, y: found.connection.to.y});
  const reverse = reverseConnection(definition, found.deck.id, found.connection);
  if (!reverse) return null;
  return Object.freeze({deckId: targetDeck.id, x: reverse.from.x, y: reverse.from.y});
}

function traversalDuration(definition, sourceDeck, connection) {
  const traversal = connection.traversal || {};
  const mode = String(traversal.mode || "instant");
  if (mode === "instant") return 0;
  if (mode === "timed") return Math.max(0, Number(traversal.duration) || 0);
  const landing = vesselConnectionLanding(definition, sourceDeck.id, connection.id);
  const targetDeck = deckFor(definition, connection.toDeckId);
  const dx = landing ? landing.x - connection.from.x : 0;
  const dy = landing ? landing.y - connection.from.y : 0;
  const levelHeight = Math.max(0, Number(traversal.levelHeight) || 3);
  const dz = targetDeck ? (Number(targetDeck.level) - Number(sourceDeck.level)) * levelHeight : 0;
  return Math.hypot(dx, dy, dz) / Math.max(0.01, Number(traversal.speed) || 1.5);
}

export function beginVesselTraversal(definition, instance, playerIndex, connectionId) {
  const key = occupantKey(playerIndex);
  const current = instance?.occupants?.[key];
  if (!current) throw new VesselContractError(`player ${playerIndex} has no vessel-local position`);
  const found = connectionFor(definition, assertId(connectionId, "connection id"));
  if (!found || found.deck.id !== current.deckId) throw new VesselContractError(`connection ${connectionId} is not on occupant deck ${current.deckId}`);
  if (!connectionPassable(definition, instance, found.connection.id)) return Object.freeze({started: false, reason: "blocked"});
  const landing = vesselConnectionLanding(definition, found.deck.id, found.connection.id);
  if (!landing) return Object.freeze({started: false, reason: "missing-landing"});
  const distance = Math.hypot(current.x - found.connection.from.x, current.y - found.connection.from.y);
  const interactionRange = Math.max(0, Number(found.connection.interactionRange) || 1.75);
  if (distance > interactionRange) return Object.freeze({started: false, reason: "too-far", distance});
  const duration = traversalDuration(definition, found.deck, found.connection);
  const interior = ensureInterior(instance);
  if (duration <= 0) {
    const next = validateVesselOccupantPosition(definition, {...landing, heading: current.heading});
    instance.occupants[key] = {...next};
    return Object.freeze({started: true, completed: true, duration: 0, position: next});
  }
  interior.traversals[key] = {connectionId: found.connection.id, fromDeckId: current.deckId, toDeckId: landing.deckId, landing: cloneData(landing), remaining: duration, duration, heading: current.heading};
  return Object.freeze({started: true, completed: false, duration});
}

export function advanceVesselDeckRuntime(definition, instance, dt, context = {}) {
  const interior = ensureInterior(instance);
  const elapsed = Math.max(0, Number(dt) || 0);
  const completed = [];
  for (const [playerKey, traversal] of Object.entries(interior.traversals)) {
    traversal.remaining = Math.max(0, Number(traversal.remaining) - elapsed);
    if (traversal.remaining > 0) continue;
    const playerIndex = Number(playerKey);
    const next = validateVesselOccupantPosition(definition, {...traversal.landing, heading: traversal.heading});
    instance.occupants[playerKey] = {...next};
    delete interior.traversals[playerKey];
    completed.push({playerIndex, connectionId: traversal.connectionId, position: next});
  }
  const water = stepVesselWater(definition, instance, elapsed);
  const emergency = advanceEmergencyLifecycle(definition, instance, elapsed, context.boat);
  return Object.freeze({completed: Object.freeze(completed), water, emergency});
}

export function claimVesselDeckResource(instance, playerIndex, resourceId) {
  const key = occupantKey(playerIndex);
  const id = assertId(resourceId, "deck resource id");
  const interior = ensureInterior(instance);
  const existing = interior.claims[id];
  if (existing != null && String(existing) !== key) return false;
  interior.claims[id] = Number(playerIndex);
  return true;
}

export function releaseVesselDeckResource(instance, playerIndex, resourceId) {
  const id = assertId(resourceId, "deck resource id");
  const interior = ensureInterior(instance);
  if (interior.claims[id] !== Number(playerIndex)) return false;
  delete interior.claims[id];
  return true;
}

export function releaseVesselOccupantResources(instance, playerIndex) {
  const interior = ensureInterior(instance);
  const numeric = Number(playerIndex);
  for (const [resourceId, owner] of Object.entries(interior.claims)) if (owner === numeric) delete interior.claims[resourceId];
  delete interior.traversals[String(playerIndex)];
}

function actionDescriptor(id, label, details = {}) { return Object.freeze({id, label, ...details}); }

function builtInConnectionActions(definition, instance, playerIndex, found) {
  const state = ensureInterior(instance).connections[found.connection.id];
  const actions = [];
  const allowed = new Set(found.connection.states || []);
  if (state?.state === "closed" && allowed.has("open")) actions.push(actionDescriptor("open", "открыть", {connectionId: found.connection.id}));
  if (state?.state === "open" && allowed.has("closed")) actions.push(actionDescriptor("close", "закрыть", {connectionId: found.connection.id}));
  if (connectionPassable(definition, instance, found.connection.id)) actions.push(actionDescriptor("traverse", found.connection.actionLabel || "перейти", {connectionId: found.connection.id}));
  return actions;
}

function interactionDistance(occupant, point) { return Math.hypot(Number(occupant?.x) - Number(point?.x), Number(occupant?.y) - Number(point?.y)); }
function withinInteractionRange(occupant, entity, fallbackPoint) {
  const point = entity?.position || fallbackPoint;
  if (!point) return false;
  return interactionDistance(occupant, point) <= Math.max(0, Number(entity?.interactionRange) || 1.75);
}

export function applyVesselDeckEntityDamage(definition, instance, event = {}) {
  const kind = String(event.kind || "");
  const id = assertId(event.id, "deck damage target id");
  const damage = Math.max(0, Number(event.damage) || 0);
  if (!damage) return Object.freeze({kind, id, damage: 0, changed: false});
  const interior = ensureInterior(instance);
  if (kind === "connection") {
    const found = connectionFor(definition, id);
    if (!found) throw new VesselContractError(`unknown connection ${id}`);
    if (found.connection.damageable !== true) return Object.freeze({kind, id, damage, changed: false, reason: "not-damageable"});
    const state = interior.connections[id] ||= connectionDefaults(found.connection);
    const before = Math.max(0, Number(state.health) || 0);
    state.health = Math.max(0, before - damage);
    if (state.health <= 0) {
      const allowed = new Set(found.connection.states || []);
      state.state = allowed.has("destroyed") ? "destroyed" : state.state;
      if (!allowed.has("destroyed")) state.enabled = false;
      const reverse = reverseConnection(definition, found.deck.id, found.connection);
      if (reverse) {
        const reverseState = interior.connections[reverse.id] ||= connectionDefaults(reverse);
        reverseState.health = 0;
        if (new Set(reverse.states || []).has("destroyed")) reverseState.state = "destroyed";
        else reverseState.enabled = false;
      }
    }
    return Object.freeze({kind, id, damage, changed: state.health !== before, health: state.health, state: state.state});
  }
  if (kind === "object") {
    const found = objectFor(definition, id);
    if (!found) throw new VesselContractError(`unknown object ${id}`);
    if (found.object.damageable !== true) return Object.freeze({kind, id, damage, changed: false, reason: "not-damageable"});
    const state = interior.objects[id] ||= objectDefaults(found.object);
    const before = Math.max(0, Number(state.health) || 0);
    state.health = Math.max(0, before - damage);
    if (state.health <= 0) state.enabled = false;
    return Object.freeze({kind, id, damage, changed: state.health !== before, health: state.health, enabled: state.enabled});
  }
  throw new VesselContractError(`unsupported deck damage target kind ${kind}`);
}

export function listVesselDeckActions(registry, definition, instance, playerIndex, target) {
  const key = occupantKey(playerIndex);
  const occupant = instance?.occupants?.[key];
  if (!occupant) return [];
  const kind = String(target?.kind || "");
  const id = assertId(target?.id, "deck target id");
  const actions = [];
  let entity = null;
  let ownerKey = null;
  if (kind === "connection") {
    const found = connectionFor(definition, id);
    if (!found || found.deck.id !== occupant.deckId || !withinInteractionRange(occupant, found.connection, found.connection.from)) return [];
    entity = found.connection; ownerKey = `connection:${id}`; actions.push(...builtInConnectionActions(definition, instance, playerIndex, found));
  } else if (kind === "object") {
    const found = objectFor(definition, id);
    if (!found || found.deck.id !== occupant.deckId || !withinInteractionRange(occupant, found.object, found.object.position)) return [];
    if (ensureInterior(instance).objects[id]?.enabled === false) return [];
    entity = found.object; ownerKey = `object:${id}`;
    if (found.object.kind === "station") {
      const resourceId = String(found.object.resourceId || found.object.id);
      const owner = ensureInterior(instance).claims[resourceId];
      if (owner == null) actions.push(actionDescriptor("occupy", found.object.occupyLabel || "занять пост", {resourceId}));
      else if (owner === Number(playerIndex)) actions.push(actionDescriptor("leave", found.object.leaveLabel || "покинуть пост", {resourceId}));
    }
  } else return [];
  for (const rule of entity.rules || []) {
    const ruleType = registry?.resolveDeckRuleType?.(rule.type);
    const runtimeState = ensureInterior(instance).rules[ruleRuntimeKey(ownerKey, rule.id)] || {};
    const provided = ruleType?.actions?.({definition, instance, playerIndex, occupant, entity, rule, state: runtimeState}) || [];
    for (const action of provided) if (action?.id && action?.label) actions.push(actionDescriptor(assertId(action.id, `rule ${rule.id} action id`), String(action.label), {ruleId: rule.id, ruleType: rule.type, ...cloneData(action)}));
  }
  const seenActions = new Set();
  for (const action of actions) { if (seenActions.has(action.id)) throw new VesselContractError(`${kind}:${id} exposes duplicate action ${action.id}`); seenActions.add(action.id); }
  return Object.freeze(actions);
}

export function performVesselDeckAction(registry, definition, instance, playerIndex, target, actionId, payload = {}) {
  const kind = String(target?.kind || ""); const id = assertId(target?.id, "deck target id"); const action = assertId(actionId, "deck action id");
  if (!listVesselDeckActions(registry, definition, instance, playerIndex, {kind, id}).some(entry => entry.id === action)) throw new VesselContractError(`deck action ${action} is not currently available for ${kind}:${id}`);
  if (kind === "connection") {
    const found = connectionFor(definition, id); if (!found) throw new VesselContractError(`unknown connection ${id}`);
    if (action === "open") return setVesselConnectionState(definition, instance, id, "open");
    if (action === "close") return setVesselConnectionState(definition, instance, id, "closed");
    if (action === "traverse") return beginVesselTraversal(definition, instance, playerIndex, id);
    return performRuleAction(registry, definition, instance, playerIndex, `connection:${id}`, found.connection, action, payload);
  }
  if (kind === "object") {
    const found = objectFor(definition, id); if (!found) throw new VesselContractError(`unknown object ${id}`);
    if (found.object.kind === "station") {
      const resourceId = String(found.object.resourceId || found.object.id);
      if (action === "occupy") return Object.freeze({handled: claimVesselDeckResource(instance, playerIndex, resourceId), resourceId, owner: ensureInterior(instance).claims[resourceId] ?? null});
      if (action === "leave") return Object.freeze({handled: releaseVesselDeckResource(instance, playerIndex, resourceId), resourceId, owner: ensureInterior(instance).claims[resourceId] ?? null});
    }
    return performRuleAction(registry, definition, instance, playerIndex, `object:${id}`, found.object, action, payload);
  }
  throw new VesselContractError(`unsupported deck target kind ${kind}`);
}

function performRuleAction(registry, definition, instance, playerIndex, ownerKey, entity, action, payload) {
  for (const rule of entity.rules || []) {
    const ruleType = registry?.resolveDeckRuleType?.(rule.type);
    if (!ruleType?.performAction) continue;
    const key = ruleRuntimeKey(ownerKey, rule.id);
    const state = ensureInterior(instance).rules[key] ||= {};
    const result = ruleType.performAction({definition, instance, playerIndex, entity, rule, state, action, payload: cloneData(payload)});
    if (result?.handled) return result;
  }
  throw new VesselContractError(`${ownerKey} does not support action ${action}`);
}

function zoneWaterConfig(definition, zoneId) {
  for (const deck of definition.decks || []) {
    const zone = (deck.zones || []).find(item => item.id === zoneId);
    if (zone) return definition.deckArchitecture?.entities?.get?.(`zone:${deck.id}:${zone.id}`)?.water || zone.water || null;
  }
  return null;
}

function zoneAtConnectionEndpoint(definition, deck, point) { return resolveVesselZoneAt(definition, deck.id, point)?.id || null; }

export function adjustVesselZoneWater(definition, instance, zoneId, delta) {
  const id = assertId(zoneId, "zone id");
  const config = zoneWaterConfig(definition, id);
  if (!config?.enabled) return 0;
  instance.zones ||= {}; instance.zones[id] ||= {health: 100, flooding: 0, fire: 0};
  instance.zones[id].flooding = clamp(Number(instance.zones[id].flooding || 0) + Number(delta || 0), 0, 100);
  return instance.zones[id].flooding;
}

export function vesselOccupantWaterState(definition, instance, playerIndex) {
  const occupant = instance?.occupants?.[String(playerIndex)];
  if (!occupant?.zoneId) return Object.freeze({mode: "dry", flooding: 0, depth: 0, damagePerSecond: 0});
  const config = zoneWaterConfig(definition, occupant.zoneId);
  if (!config?.enabled) return Object.freeze({mode: "dry", flooding: 0, depth: 0, damagePerSecond: 0});
  const flooding = clamp(instance?.zones?.[occupant.zoneId]?.flooding, 0, 100);
  const depth = config.maxDepth * flooding / 100;
  let mode = "dry";
  if (flooding > 0 && depth < 0.25) mode = "ankle";
  else if (depth < config.swimDepth) mode = "wading";
  else if (flooding < 100) mode = "swimming";
  else mode = "full";
  const damagePerSecond = flooding >= 100 ? Math.max(0, Number(config.fullDamagePerSecond) || 0) : 0;
  return Object.freeze({mode, flooding, depth, damagePerSecond, underwaterAcoustics: cloneData(config.underwaterAcoustics || {})});
}

export function stepVesselWater(definition, instance, dt) {
  const elapsed = Math.max(0, Number(dt) || 0);
  if (!elapsed) return Object.freeze({changed: Object.freeze([])});
  const changes = new Map(); const processedLinks = new Set();
  for (const deck of definition.decks || []) {
    for (const connection of deck.connections || []) {
      const reverse = reverseConnection(definition, deck.id, connection);
      const linkKey = reverse ? [connection.id, reverse.id].sort().join("|") : `one-way:${connection.id}`;
      if (processedLinks.has(linkKey)) continue; processedLinks.add(linkKey);
      const targetDeck = deckFor(definition, connection.toDeckId); const landing = vesselConnectionLanding(definition, deck.id, connection.id);
      if (!targetDeck || !landing) continue;
      const fromZoneId = zoneAtConnectionEndpoint(definition, deck, connection.from); const toZoneId = zoneAtConnectionEndpoint(definition, targetDeck, landing);
      if (!fromZoneId || !toZoneId || fromZoneId === toZoneId) continue;
      const fromConfig = zoneWaterConfig(definition, fromZoneId); const toConfig = zoneWaterConfig(definition, toZoneId);
      if (!fromConfig?.enabled || !toConfig?.enabled) continue;
      const state = ensureInterior(instance).connections[connection.id]; const water = connection.water || {};
      const openForWater = water.alwaysOpen === true || connectionPassable(definition, instance, connection.id) || water.watertight === false;
      if (!openForWater) continue;
      const flowRate = Math.max(0, Number(water.flowRate) || 0); if (!flowRate) continue;
      const from = clamp(instance.zones[fromZoneId]?.flooding, 0, 100); const to = clamp(instance.zones[toZoneId]?.flooding, 0, 100); const difference = from - to;
      if (Math.abs(difference) < 0.01) continue;
      const transfer = Math.sign(difference) * Math.min(Math.abs(difference) / 2, flowRate * elapsed);
      changes.set(fromZoneId, (changes.get(fromZoneId) || 0) - transfer); changes.set(toZoneId, (changes.get(toZoneId) || 0) + transfer);
      if (state && water.watertight === true && !connectionPassable(definition, instance, connection.id)) { changes.delete(fromZoneId); changes.delete(toZoneId); }
    }
  }
  const changed = [];
  for (const [zoneId, delta] of changes) changed.push({zoneId, flooding: adjustVesselZoneWater(definition, instance, zoneId, delta)});
  return Object.freeze({changed: Object.freeze(changed)});
}

function connectionAcousticTransmission(definition, instance, connection) {
  const config = {...(definition.deckArchitecture?.acoustics || {}), ...(connection.acoustics || {})};
  const state = ensureInterior(instance).connections[connection.id]?.state || connection.initialState || "open";
  if (state === "destroyed" || state === "open") return clamp(config.openTransmission ?? config.transmission ?? 1, 0, 1);
  if (["closed", "locked", "jammed", "blocked"].includes(state)) return clamp(config.closedTransmission ?? config.transmission ?? 0.18, 0, 1);
  return clamp(config.transmission ?? 1, 0, 1);
}

export function resolveVesselAcousticPath(definition, instance, source, listener) {
  const fromDeckId = assertId(source?.deckId, "acoustic source deckId"); const toDeckId = assertId(listener?.deckId, "acoustic listener deckId");
  const fromDeck = deckFor(definition, fromDeckId); const toDeck = deckFor(definition, toDeckId); if (!fromDeck || !toDeck) return null;
  if (fromDeckId === toDeckId) {
    const zone = resolveVesselZoneAt(definition, fromDeckId, source);
    return Object.freeze({gain: 1, sameDeck: true, connections: Object.freeze([]), sourceZoneId: zone?.id || null, transitionMs: Number(definition.deckArchitecture?.acoustics?.transitionMs) || 180});
  }
  const queue = [{deckId: fromDeckId, gain: 1, path: []}]; const best = new Map([[fromDeckId, 1]]);
  while (queue.length) {
    queue.sort((a, b) => b.gain - a.gain); const current = queue.shift();
    if (current.deckId === toDeckId) return Object.freeze({gain: current.gain, sameDeck: false, connections: Object.freeze(current.path.map(item => Object.freeze(item))), transitionMs: Number(definition.deckArchitecture?.acoustics?.transitionMs) || 180});
    const deck = deckFor(definition, current.deckId);
    for (const connection of deck?.connections || []) {
      const transmission = connectionAcousticTransmission(definition, instance, connection); if (transmission <= 0) continue;
      const nextGain = current.gain * transmission; if (nextGain <= (best.get(connection.toDeckId) || 0) + 1e-9) continue;
      best.set(connection.toDeckId, nextGain); queue.push({deckId: connection.toDeckId, gain: nextGain, path: [...current.path, {connectionId: connection.id, state: ensureInterior(instance).connections[connection.id]?.state || connection.initialState, transmission}]});
    }
  }
  return null;
}

export function vesselSpatialSource(definition, source = {}) {
  const kind = String(source.kind || "point");
  if (kind === "point") {
    if (!source.deckId || !Number.isFinite(Number(source.x)) || !Number.isFinite(Number(source.y))) return null;
    return Object.freeze({deckId: String(source.deckId), x: Number(source.x), y: Number(source.y), distributed: false});
  }
  if (kind === "object") { const found = objectFor(definition, source.id); return found ? Object.freeze({deckId: found.deck.id, x: found.object.position.x, y: found.object.position.y, distributed: false}) : null; }
  if (kind === "module") {
    const module = (definition.modules || []).find(item => item.id === source.id);
    const mount = module?.mounts?.map(id => (definition.mounts || []).find(item => item.id === id)).find(item => item?.position && item?.deckId);
    return mount ? Object.freeze({deckId: mount.deckId, x: mount.position.x, y: mount.position.y, distributed: false}) : null;
  }
  if (kind === "zone") for (const deck of definition.decks || []) { const zone = (deck.zones || []).find(item => item.id === source.id); if (zone) return Object.freeze({deckId: deck.id, zoneId: zone.id, distributed: true}); }
  return null;
}

export function vesselInertiaResponse(definition, kind, motion = {}) {
  const config = kind === "cargo" ? definition.deckArchitecture?.cargoInertia : definition.deckArchitecture?.playerInertia;
  if (!config || config.mode !== "physical") return Object.freeze({active: false, shiftX: 0, shiftY: 0, fall: false, overboardRisk: false});
  const scale = Math.max(0, Number(config.scale) || 0); const shiftX = -Number(motion.lateralAcceleration || 0) * scale; const shiftY = -Number(motion.longitudinalAcceleration || 0) * scale; const force = Math.hypot(shiftX, shiftY);
  return Object.freeze({active: true, shiftX, shiftY, force, fall: Number(config.fallThreshold) > 0 && force >= Number(config.fallThreshold), overboardRisk: Number(config.overboardThreshold) > 0 && force >= Number(config.overboardThreshold)});
}

export function vesselInteriorTilt(definition, boat) {
  if (definition.deckArchitecture?.sinking?.geometryTilt !== true) return Object.freeze({enabled: false, roll: 0, pitch: 0});
  return Object.freeze({enabled: true, roll: Number(boat?.roll) || 0, pitch: Number(boat?.pitch) || 0});
}

export function vesselObjectFloodingBehavior(definition, instance, objectId) {
  const found = objectFor(definition, assertId(objectId, "object id")); if (!found) return null;
  const zoneId = found.object.zoneId || resolveVesselZoneAt(definition, found.deck.id, found.object.position)?.id || null;
  const flooding = zoneId ? clamp(instance.zones?.[zoneId]?.flooding, 0, 100) : 0;
  const behavior = String(found.object.buoyancy || (found.object.fixed === true ? "fixed" : "sink"));
  if (!["float", "sink", "fixed"].includes(behavior)) throw new VesselContractError(`object ${found.object.id} has invalid buoyancy ${behavior}`);
  return Object.freeze({objectId: found.object.id, zoneId, flooding, behavior, affected: flooding > 0 && behavior !== "fixed"});
}

function advanceEmergencyLifecycle(definition, instance, dt, boat) {
  const config = definition.deckArchitecture?.sinking || {mode: "simple"}; const interior = ensureInterior(instance);
  if (config.mode !== "emergency-phase" || !(Number(boat?.hull) <= 0)) return null;
  interior.emergency ||= {phase: "critical", elapsed: 0}; interior.emergency.elapsed += Math.max(0, Number(dt) || 0);
  const floodRate = Math.max(0, Number(config.floodRate) || 0);
  if (floodRate > 0) for (const deck of definition.decks || []) for (const zone of deck.zones || []) if (zoneWaterConfig(definition, zone.id)?.enabled) adjustVesselZoneWater(definition, instance, zone.id, floodRate * Math.max(0, Number(dt) || 0));
  if (Number(config.emergencyDuration) > 0 && interior.emergency.elapsed >= Number(config.emergencyDuration)) interior.emergency.phase = "lost";
  return Object.freeze({...interior.emergency});
}

function persistentSubset(value, fields) {
  if (!value || typeof value !== "object") return {};
  if (!Array.isArray(fields) || !fields.length) return cloneData(value);
  const result = {}; for (const field of fields) if (Object.hasOwn(value, field)) result[field] = cloneData(value[field]); return result;
}

export function vesselDeckPersistentState(registry, definition, instance) {
  const interior = ensureInterior(instance); const rules = {};
  for (const owner of definition.deckArchitecture?.ruleOwners || []) for (const rule of owner.rules || []) {
    const ruleType = registry?.resolveDeckRuleType?.(rule.type); const key = ruleRuntimeKey(owner.owner, rule.id); const current = interior.rules[key];
    if (current == null || ruleType?.persistent === false) continue; rules[key] = persistentSubset(current, ruleType?.persistentFields);
  }
  const zones = {}; const connections = {}; const objects = {};
  for (const deck of definition.decks || []) {
    for (const zone of deck.zones || []) if (zone.persistent !== false && instance.zones?.[zone.id]) zones[zone.id] = cloneData(instance.zones[zone.id]);
    for (const connection of deck.connections || []) if (connection.persistent !== false && interior.connections[connection.id]) connections[connection.id] = cloneData(interior.connections[connection.id]);
    for (const object of deck.objects || []) if (object.persistent !== false && interior.objects[object.id]) objects[object.id] = cloneData(interior.objects[object.id]);
  }
  return Object.freeze({version: VESSEL_DECK_RUNTIME_VERSION, zones, connections, objects, rules});
}

export function restoreVesselDeckPersistentState(registry, definition, instance, persisted) {
  const source = persisted && typeof persisted === "object" ? persisted : {}; const interior = ensureInterior(instance);
  for (const deck of definition.decks || []) {
    for (const zone of deck.zones || []) if (source.zones?.[zone.id] && zone.persistent !== false) instance.zones[zone.id] = {...instance.zones[zone.id], ...cloneData(source.zones[zone.id])};
    for (const connection of deck.connections || []) if (source.connections?.[connection.id] && connection.persistent !== false) interior.connections[connection.id] = {...interior.connections[connection.id], ...cloneData(source.connections[connection.id])};
    for (const object of deck.objects || []) if (source.objects?.[object.id] && object.persistent !== false) interior.objects[object.id] = {...interior.objects[object.id], ...cloneData(source.objects[object.id])};
  }
  for (const owner of definition.deckArchitecture?.ruleOwners || []) for (const rule of owner.rules || []) {
    const ruleType = registry?.resolveDeckRuleType?.(rule.type); if (ruleType?.persistent === false) continue; const key = ruleRuntimeKey(owner.owner, rule.id);
    if (source.rules?.[key]) interior.rules[key] = {...interior.rules[key], ...cloneData(source.rules[key])};
  }
  return interior;
}

export function vesselDeckNetworkState(registry, definition, instance) {
  const interior = ensureInterior(instance); const rules = {};
  for (const owner of definition.deckArchitecture?.ruleOwners || []) for (const rule of owner.rules || []) {
    const ruleType = registry?.resolveDeckRuleType?.(rule.type); const key = ruleRuntimeKey(owner.owner, rule.id); const current = interior.rules[key];
    if (current == null || ruleType?.networked === false) continue; rules[key] = persistentSubset(current, ruleType?.networkStateFields);
  }
  return Object.freeze({version: VESSEL_DECK_RUNTIME_VERSION, connections: cloneData(interior.connections), objects: cloneData(interior.objects), claims: cloneData(interior.claims), traversals: cloneData(interior.traversals), rules});
}

export function safeReconnectPosition(definition, instance, playerIndex, previous = null) {
  const policy = definition.deckArchitecture?.reconnect || {mode: "last-valid-or-safe"};
  if (previous && policy.mode !== "safe-point") { try { return validateVesselOccupantPosition(definition, previous); } catch (_) {} }
  const points = definition.deckArchitecture?.boarding?.points || []; const safe = points.find(point => point.safe !== false) || points[0];
  if (safe) return validateVesselOccupantPosition(definition, {...safe.position, deckId: safe.deckId, heading: 0});
  const first = definition.decks?.[0]; if (!first) return null; const point = first.shape?.outer?.[0]; if (!point) return null;
  const centroid = first.shape.outer.reduce((acc, current) => ({x: acc.x + current.x / first.shape.outer.length, y: acc.y + current.y / first.shape.outer.length}), {x: 0, y: 0});
  return validateVesselOccupantPosition(definition, {deckId: first.id, x: point.x * 0.9 + centroid.x * 0.1, y: point.y * 0.9 + centroid.y * 0.1, heading: 0});
}
