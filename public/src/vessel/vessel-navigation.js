"use strict";

import {legacyVesselViews} from "./vessel-legacy-adapter.js";
import {nativeVesselByInstanceId, nativeVesselForBoat, vesselRegistry} from "./vessel-runtime.js";
import {findPathInShape, pointInShape} from "./vessel-deck-compiler.js";
import {connectionPassable, resolveVesselZoneAt, vesselConnectionLanding} from "./vessel-deck-runtime.js";

const LEGACY_PREFIX = "vessel:";
const INSTANCE_PREFIX = "vessel-id:";
const INTERIOR_PREFIX = "vessel-interior:";

function boatById(world, boatId) {
  return Number.isInteger(boatId) ? world?.boats?.[boatId] || null : null;
}

function viewForBoat(world, boat) {
  if (!boat) return null;
  const legacy = legacyVesselViews(world).find(view => view.legacyBoatId === boat.id);
  const native = nativeVesselForBoat(world, boat.id);
  const definition = native ? vesselRegistry().resolveVesselType(native.instance.typeId) : null;
  const navigationTarget = definition ? definition.capabilities.sonarTarget === true : legacy?.navigationTarget === true;
  return {boat, native, instanceId: native?.instance?.instanceId || null, label: definition?.presentation?.label || legacy?.label || String(boat.label || "судно"), navigationTarget};
}

function policySets(world) {
  const policy = world?.vesselNavigation || {};
  return {
    hidden: new Set([...(policy.hiddenTargets || []), ...(policy.hiddenInstanceIds || [])].map(String)),
    mission: new Set([...(policy.missionTargets || []), ...(policy.missionRequiredInstanceIds || [])].map(String)),
  };
}

function stableTargetId(view) {
  return view?.instanceId ? `${INSTANCE_PREFIX}${encodeURIComponent(view.instanceId)}` : `${LEGACY_PREFIX}${Number(view?.boat?.id)}`;
}

function isMissionRequired(policy, view, targetId) {
  return policy.mission.has(targetId) || (view?.instanceId && policy.mission.has(view.instanceId)) || policy.mission.has(String(view?.boat?.id));
}

function isHidden(policy, view, targetId) {
  return policy.hidden.has(targetId) || (view?.instanceId && policy.hidden.has(view.instanceId)) || policy.hidden.has(String(view?.boat?.id));
}

export function vesselNavigationTargetId(identity) {
  if (Number.isInteger(identity)) return `${LEGACY_PREFIX}${identity}`;
  const instanceId = String(identity || "").trim();
  return instanceId ? `${INSTANCE_PREFIX}${encodeURIComponent(instanceId)}` : null;
}

export function parseVesselNavigationTargetId(value) {
  const text = String(value || "");
  if (text.startsWith(INSTANCE_PREFIX)) {
    try {
      const instanceId = decodeURIComponent(text.slice(INSTANCE_PREFIX.length));
      return instanceId ? {instanceId, boatId: null} : null;
    } catch (_) { return null; }
  }
  if (!text.startsWith(LEGACY_PREFIX)) return null;
  const id = Number(text.slice(LEGACY_PREFIX.length));
  return Number.isInteger(id) && id >= 0 ? {instanceId: null, boatId: id} : null;
}

export function listVesselNavigationTargets(world, playerIndex) {
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat) ? world.players[playerIndex].activeBoat : null;
  const policy = policySets(world);
  const targets = [];
  for (const boat of world?.boats || []) {
    if (!boat || boat.sunk || boat.reserved || boat.id === currentBoatId) continue;
    const view = viewForBoat(world, boat);
    if (!view?.navigationTarget) continue;
    const id = stableTargetId(view);
    const missionRequired = isMissionRequired(policy, view, id);
    if (isHidden(policy, view, id) && !missionRequired) continue;
    targets.push({id, instanceId: view.instanceId, boatId: boat.id, label: view.label, x: Number(boat.x) || 0, y: Number(boat.y) || 0, missionRequired});
  }
  return targets;
}

export function vesselNavigationTargetFromId(world, playerIndex, navigationTargetId) {
  const parsed = parseVesselNavigationTargetId(navigationTargetId);
  if (!parsed) return null;
  const native = parsed.instanceId ? nativeVesselByInstanceId(world, parsed.instanceId) : null;
  const boatId = native?.boat?.id ?? parsed.boatId;
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat) ? world.players[playerIndex].activeBoat : null;
  if (boatId == null || boatId === currentBoatId) return null;
  const boat = boatById(world, boatId);
  if (!boat || boat.sunk || boat.reserved) return null;
  const view = viewForBoat(world, boat);
  if (!view?.navigationTarget) return null;
  const id = stableTargetId(view);
  const policy = policySets(world);
  const missionRequired = isMissionRequired(policy, view, id);
  if (isHidden(policy, view, id) && !missionRequired) return null;
  return {id, kind: "vessel", instanceId: view.instanceId, boatId: boat.id, label: view.label, x: Number(boat.x) || 0, y: Number(boat.y) || 0, missionRequired};
}

function centroid(shape) {
  const points = shape?.outer || [];
  if (!points.length) return null;
  const center = points.reduce((sum, point) => ({x: sum.x + point.x / points.length, y: sum.y + point.y / points.length}), {x: 0, y: 0});
  if (pointInShape(center, shape)) return center;
  return {...points[0]};
}

function interiorTargetId(instanceId, kind, id) {
  return `${INTERIOR_PREFIX}${encodeURIComponent(instanceId)}:${kind}:${encodeURIComponent(id)}`;
}

export function parseVesselInteriorNavigationTargetId(value) {
  const text = String(value || "");
  if (!text.startsWith(INTERIOR_PREFIX)) return null;
  const rest = text.slice(INTERIOR_PREFIX.length);
  const first = rest.indexOf(":");
  const second = rest.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) return null;
  try {
    const instanceId = decodeURIComponent(rest.slice(0, first));
    const kind = rest.slice(first + 1, second);
    const id = decodeURIComponent(rest.slice(second + 1));
    if (!instanceId || !["deck", "zone", "landmark", "object"].includes(kind) || !id) return null;
    return {instanceId, kind, id};
  } catch (_) { return null; }
}

function activeWalkableEntry(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  const boatId = Number.isInteger(player?.activeBoat) ? player.activeBoat : null;
  if (boatId == null) return null;
  const entry = nativeVesselForBoat(world, boatId);
  if (!entry?.definition?.capabilities?.walkableInterior) return null;
  if (!entry.instance?.occupants?.[playerIndex]) return null;
  return entry;
}

function targetPosition(definition, kind, id) {
  if (kind === "deck") {
    const deck = definition.decks.find(item => item.id === id);
    const point = deck ? centroid(deck.shape) : null;
    return deck && point ? {deck, point, entity: deck} : null;
  }
  for (const deck of definition.decks || []) {
    if (kind === "zone") {
      const entity = deck.zones.find(item => item.id === id);
      const point = entity?.shape ? centroid(entity.shape) : null;
      if (entity && point) return {deck, point, entity};
    }
    if (kind === "landmark") {
      const entity = deck.landmarks.find(item => item.id === id);
      if (entity) return {deck, point: entity.position, entity};
    }
    if (kind === "object") {
      const entity = deck.objects?.find(item => item.id === id);
      if (entity) return {deck, point: entity.position, entity};
    }
  }
  return null;
}

export function listVesselInteriorNavigationTargets(world, playerIndex) {
  const entry = activeWalkableEntry(world, playerIndex);
  if (!entry) return [];
  const targets = [];
  for (const deck of entry.definition.decks || []) {
    targets.push({id: interiorTargetId(entry.instance.instanceId, "deck", deck.id), kind: "deck", entityId: deck.id, label: deck.label, deckId: deck.id});
    for (const zone of deck.zones || []) if (zone.navigation !== false && zone.shape) targets.push({id: interiorTargetId(entry.instance.instanceId, "zone", zone.id), kind: "zone", entityId: zone.id, label: zone.label, deckId: deck.id});
    for (const landmark of deck.landmarks || []) if (landmark.navigation !== false) targets.push({id: interiorTargetId(entry.instance.instanceId, "landmark", landmark.id), kind: "landmark", entityId: landmark.id, label: landmark.label, deckId: deck.id});
    for (const object of deck.objects || []) if (object.navigation !== false) targets.push({id: interiorTargetId(entry.instance.instanceId, "object", object.id), kind: "object", entityId: object.id, label: object.label, deckId: deck.id});
  }
  return Object.freeze(targets);
}

function pathLength(path) {
  let total = 0;
  for (let index = 1; index < (path || []).length; index += 1) total += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  return total;
}

function hazardAt(definition, instance, deckId, point) {
  const zone = resolveVesselZoneAt(definition, deckId, point);
  if (!zone) return null;
  const state = instance.zones?.[zone.id] || {};
  const warnings = [];
  if (Number(state.fire) > 0) warnings.push(`пожар: ${Math.round(Number(state.fire))}%`);
  if (Number(state.flooding) > 0) warnings.push(`затопление: ${Math.round(Number(state.flooding))}%`);
  return warnings.length ? {zoneId: zone.id, zoneLabel: zone.label, warnings} : null;
}

function stateKey(deckId, point) {
  return `${deckId}:${Number(point.x).toFixed(4)}:${Number(point.y).toFixed(4)}`;
}

export function vesselInteriorNavigationRoute(world, playerIndex, navigationTargetId) {
  const parsed = parseVesselInteriorNavigationTargetId(navigationTargetId);
  if (!parsed) return null;
  const entry = activeWalkableEntry(world, playerIndex);
  if (!entry || entry.instance.instanceId !== parsed.instanceId) return null;
  const target = targetPosition(entry.definition, parsed.kind, parsed.id);
  const start = entry.instance.occupants[playerIndex];
  if (!target || !start) return null;
  const queue = [{deckId: start.deckId, point: {x: start.x, y: start.y}, cost: 0, waypoints: [], warnings: []}];
  const best = new Map([[stateKey(start.deckId, start), 0]]);
  let winner = null;
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const state = queue.shift();
    const deck = entry.definition.decks.find(item => item.id === state.deckId);
    if (!deck) continue;
    if (state.deckId === target.deck.id) {
      const finalPath = findPathInShape(deck.shape, state.point, target.point);
      if (finalPath) {
        const warnings = [...state.warnings];
        const targetHazard = hazardAt(entry.definition, entry.instance, deck.id, target.point);
        if (targetHazard && !warnings.some(item => item.zoneId === targetHazard.zoneId)) warnings.push(targetHazard);
        winner = {cost: state.cost + pathLength(finalPath), waypoints: [...state.waypoints, ...finalPath.slice(1).map(point => ({kind: "walk", deckId: deck.id, point}))], warnings};
        break;
      }
    }
    for (const connection of deck.connections || []) {
      if (!connectionPassable(entry.definition, entry.instance, connection.id)) continue;
      const localPath = findPathInShape(deck.shape, state.point, connection.from);
      if (!localPath) continue;
      const landing = vesselConnectionLanding(entry.definition, deck.id, connection.id);
      if (!landing) continue;
      const nextDeck = entry.definition.decks.find(item => item.id === landing.deckId);
      if (!nextDeck || !findPathInShape(nextDeck.shape, landing, landing)) continue;
      const warnings = [...state.warnings];
      const before = hazardAt(entry.definition, entry.instance, deck.id, connection.from);
      const after = hazardAt(entry.definition, entry.instance, nextDeck.id, landing);
      for (const hazard of [before, after]) if (hazard && !warnings.some(item => item.zoneId === hazard.zoneId)) warnings.push(hazard);
      const nextCost = state.cost + pathLength(localPath) + 1;
      const key = stateKey(nextDeck.id, landing);
      if (nextCost >= (best.get(key) ?? Infinity)) continue;
      best.set(key, nextCost);
      queue.push({
        deckId: nextDeck.id,
        point: {x: landing.x, y: landing.y},
        cost: nextCost,
        warnings,
        waypoints: [
          ...state.waypoints,
          ...localPath.slice(1).map(point => ({kind: "walk", deckId: deck.id, point})),
          {kind: "connection", deckId: deck.id, connectionId: connection.id, label: connection.label, point: connection.from},
          {kind: "land", deckId: nextDeck.id, connectionId: connection.id, point: {x: landing.x, y: landing.y}},
        ],
      });
    }
  }
  if (!winner) return null;
  return Object.freeze({
    id: navigationTargetId,
    instanceId: entry.instance.instanceId,
    target: Object.freeze({kind: parsed.kind, id: parsed.id, label: target.entity.label, deckId: target.deck.id, point: Object.freeze({...target.point})}),
    waypoints: Object.freeze(winner.waypoints.map(waypoint => Object.freeze(waypoint))),
    warnings: Object.freeze(winner.warnings.map(warning => Object.freeze({...warning, warnings: Object.freeze([...warning.warnings])}))),
    distance: winner.cost,
  });
}

export function vesselInteriorNavigationGuidance(world, playerIndex, navigationTargetId) {
  const route = vesselInteriorNavigationRoute(world, playerIndex, navigationTargetId);
  if (!route) return null;
  const entry = activeWalkableEntry(world, playerIndex);
  const local = entry?.instance?.occupants?.[playerIndex];
  const next = route.waypoints[0] || null;
  if (!local || !next) return Object.freeze({...route, arrived: true, nextWaypoint: null});
  const dx = Number(next.point?.x) - Number(local.x);
  const dy = Number(next.point?.y) - Number(local.y);
  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI - Number(local.heading || 0) + 180) % 360 + 360) % 360 - 180;
  return Object.freeze({...route, arrived: false, nextWaypoint: next, nextDistance: Math.hypot(dx, dy), relativeBearing: bearing});
}
