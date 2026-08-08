"use strict";

import {pointInShape} from "../vessel-deck-compiler.js";
import {
  connectionPassable,
  listVesselDeckActions,
  performVesselDeckAction,
  setVesselConnectionState,
  tryMoveVesselOccupant,
} from "../vessel-deck-runtime.js";
import {
  clearVesselOccupantPosition,
  setVesselOccupantPosition,
  vesselLocalToWorld,
} from "../vessel-interior.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const wrap = value => ((Number(value || 0) + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function entryForBoat(nativeVessels, boatId) {
  return (nativeVessels || []).find(entry => entry?.boat?.id === boatId) || null;
}

function entryForPlayer(world, nativeVessels, playerIndex) {
  const boatId = world?.players?.[playerIndex]?.activeBoat;
  return Number.isInteger(boatId) ? entryForBoat(nativeVessels, boatId) : null;
}

function walkableMeta(instance) {
  instance.interior ||= {};
  instance.interior.walkableControl ||= {
    held: {},
    inputs: {},
    pendingTraversal: {},
    edgeAt: {},
  };
  const meta = instance.interior.walkableControl;
  meta.held ||= {};
  meta.inputs ||= {};
  meta.pendingTraversal ||= {};
  meta.edgeAt ||= {};
  return meta;
}

function deckFor(definition, deckId) {
  return (definition?.decks || []).find(deck => deck.id === deckId) || null;
}

function connectionFor(definition, connectionId) {
  for (const deck of definition?.decks || []) {
    const connection = (deck.connections || []).find(item => item.id === connectionId);
    if (connection) return {deck, connection};
  }
  return null;
}

function helmStations(definition) {
  const result = [];
  for (const deck of definition?.decks || []) {
    for (const object of deck.objects || []) {
      if (object.kind !== "station") continue;
      if (object.controlsVessel === true || object.stationRole === "helm") result.push({deck, object});
    }
  }
  return result;
}

function helmOwner(entry) {
  const claims = entry?.instance?.interior?.claims || {};
  for (const {object} of helmStations(entry?.definition)) {
    const resourceId = String(object.resourceId || object.id);
    const owner = claims[resourceId];
    if (Number.isInteger(owner) && entry.instance?.occupants?.[owner]) return owner;
  }
  return null;
}

function syncControlAuthority(world, entry) {
  if (!entry?.definition?.deckArchitecture?.enabled) return;
  const occupants = entry.instance?.occupants || {};
  for (const rawIndex of Object.keys(occupants)) {
    const player = world?.players?.[Number(rawIndex)];
    if (player && player.activeBoat === entry.boat.id) player.vesselDeckInputOwned = true;
  }
  if (entry.definition.deckArchitecture?.control?.mode !== "stations") return;
  const owner = helmOwner(entry);
  if (Number.isInteger(owner)) {
    entry.boat.driver = owner;
    return;
  }
  if (Number.isInteger(entry.boat.driver) && occupants[entry.boat.driver]) entry.boat.driver = null;
}

function firstBoardingPoint(definition) {
  const points = definition?.deckArchitecture?.boarding?.points || [];
  return points.find(point => point.safe !== false) || points[0] || null;
}

function enterDeck(world, entry, playerIndex, event = null) {
  if (!entry?.definition?.capabilities?.walkableInterior) return false;
  if (entry.definition.deckArchitecture?.boarding?.mode !== "deck-entry") return false;
  const player = world?.players?.[playerIndex];
  if (!player || player.activeBoat !== entry.boat.id) return false;
  if (!entry.instance?.occupants?.[playerIndex]) {
    const point = firstBoardingPoint(entry.definition);
    if (!point) return false;
    setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, {
      deckId: point.deckId,
      x: point.position.x,
      y: point.position.y,
      heading: Number(point.heading) || 0,
    });
  }
  player.vesselDeckInputOwned = true;
  syncControlAuthority(world, entry);
  if (event) {
    const point = firstBoardingPoint(entry.definition);
    const deck = deckFor(entry.definition, point?.deckId);
    event.type = "vessel-deck-enter";
    event.boatId = entry.boat.id;
    event.sourcePlayer = playerIndex;
    event.deckId = point?.deckId || null;
    event.text = String(point?.enterText || `Ты поднялся на ${deck?.label || "палубу"}.`);
    const worldPoint = vesselLocalToWorld(entry.boat, entry.instance.occupants[playerIndex]);
    event.x = worldPoint.x;
    event.y = worldPoint.y;
  }
  return true;
}

function normalizeBoardingEvents({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const events = (world.events || []).slice(eventStart);
  for (const event of events) {
    if (event?.type !== "enter") continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : Number(event.targets?.find(Number.isInteger));
    if (!Number.isInteger(playerIndex)) continue;
    const boatId = Number.isInteger(event.boatId) ? event.boatId : world.players?.[playerIndex]?.activeBoat;
    const entry = entryForBoat(nativeVessels, boatId);
    enterDeck(world, entry, playerIndex, event);
  }
}

function restoreLegacyAboardPlayers(world, nativeVessels) {
  for (const entry of nativeVessels || []) {
    if (entry?.definition?.deckArchitecture?.boarding?.mode !== "deck-entry") continue;
    for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
      const player = world.players[playerIndex];
      if (!player || player.activeBoat !== entry.boat.id || entry.instance?.occupants?.[playerIndex]) continue;
      const crew = Array.isArray(entry.boat.crew) ? entry.boat.crew : [];
      if (!crew.includes(playerIndex) && entry.boat.driver !== playerIndex) continue;
      const previous = entry.boat.vesselRuntimeState?.occupantMemory?.[playerIndex] || null;
      const point = previous || (() => {
        const boarding = firstBoardingPoint(entry.definition);
        return boarding ? {deckId: boarding.deckId, x: boarding.position.x, y: boarding.position.y, heading: Number(boarding.heading) || 0} : null;
      })();
      if (!point) continue;
      try {
        setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, point);
        player.vesselDeckInputOwned = true;
        emit(world, "vessel-deck-restored", "Ты находишься на палубе судна.", [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id});
      } catch (_) {}
    }
    syncControlAuthority(world, entry);
  }
}

function rawHeld(meta, playerIndex, key, value) {
  const id = String(playerIndex);
  meta.held[id] ||= {};
  const previous = Boolean(meta.held[id][key]);
  meta.held[id][key] = Boolean(value);
  return Boolean(value) && !previous;
}

function suppressField(input, field) {
  if (Object.prototype.hasOwnProperty.call(input || {}, field)) input[field] = false;
}

function suppressDeckControls(input) {
  for (const field of ["up", "down", "left", "right", "run", "jump", "action", "attack", "pump", "repair", "guide"]) suppressField(input, field);
}

function distanceTo(occupant, point) {
  return Math.hypot((Number(occupant?.x) || 0) - (Number(point?.x) || 0), (Number(occupant?.y) || 0) - (Number(point?.y) || 0));
}

function candidateInteractions(registry, entry, playerIndex) {
  const occupant = entry.instance?.occupants?.[playerIndex];
  if (!occupant) return [];
  const deck = deckFor(entry.definition, occupant.deckId);
  if (!deck) return [];
  const result = [];
  for (const connection of deck.connections || []) {
    const actions = listVesselDeckActions(registry, entry.definition, entry.instance, playerIndex, {kind: "connection", id: connection.id});
    if (actions.length) result.push({kind: "connection", id: connection.id, entity: connection, distance: distanceTo(occupant, connection.from), actions});
  }
  for (const object of deck.objects || []) {
    const actions = listVesselDeckActions(registry, entry.definition, entry.instance, playerIndex, {kind: "object", id: object.id});
    if (actions.length) result.push({kind: "object", id: object.id, entity: object, distance: distanceTo(occupant, object.position), actions});
  }
  return result.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}

function preferredAction(candidate) {
  const ids = new Set(candidate.actions.map(action => action.id));
  if (candidate.kind === "object") {
    if (ids.has("leave")) return "leave";
    if (ids.has("occupy")) return "occupy";
  }
  if (candidate.kind === "connection") {
    if (ids.has("open") && !ids.has("traverse")) return "open";
    if (ids.has("traverse")) return "traverse";
    if (ids.has("close")) return "close";
  }
  return candidate.actions[0]?.id || null;
}

function connectionText(connection, action, fallback) {
  if (action === "open") return String(connection.openText || fallback || `Ты открыл ${connection.label}.`);
  if (action === "close") return String(connection.closeText || fallback || `Ты закрыл ${connection.label}.`);
  if (action === "traverse") return String(connection.traverseText || fallback || `Ты проходишь через ${connection.label}.`);
  return String(fallback || "");
}

function stationText(object, action) {
  if (action === "occupy") return String(object.occupyText || `Ты занял ${object.label}.`);
  return String(object.leaveText || `Ты отошёл от ${object.label}.`);
}

function setHelmAfterAction(world, entry, playerIndex, object, action) {
  if (object?.kind !== "station" || !(object.controlsVessel === true || object.stationRole === "helm")) return;
  if (action === "occupy") entry.boat.driver = playerIndex;
  if (action === "leave" && entry.boat.driver === playerIndex) {
    entry.boat.driver = null;
    entry.boat.throttle = 0;
    entry.boat.rudder = 0;
  }
  syncControlAuthority(world, entry);
}

function finishTraversal(world, entry, playerIndex, pending) {
  if (pending.autoCloseAfterTraverse) {
    const found = connectionFor(entry.definition, pending.connectionId);
    if (found && connectionPassable(entry.definition, entry.instance, pending.connectionId)) {
      try { setVesselConnectionState(entry.definition, entry.instance, pending.connectionId, "closed"); } catch (_) {}
    }
  }
  const local = entry.instance?.occupants?.[playerIndex];
  const point = local ? vesselLocalToWorld(entry.boat, local) : entry.boat;
  emit(world, "vessel-deck-traversal-complete", pending.arrivalText || "Переход завершён.", [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: entry.boat.id,
    connectionId: pending.connectionId,
    deckId: local?.deckId || null,
    x: point?.x,
    y: point?.y,
  });
}

function contextAction(world, registry, entry, playerIndex) {
  const [candidate] = candidateInteractions(registry, entry, playerIndex);
  if (!candidate) return false;
  const action = preferredAction(candidate);
  if (!action) return false;
  const result = performVesselDeckAction(registry, entry.definition, entry.instance, playerIndex, {kind: candidate.kind, id: candidate.id}, action);
  if (candidate.kind === "object") {
    setHelmAfterAction(world, entry, playerIndex, candidate.entity, action);
    emit(world, `vessel-deck-${action}`, stationText(candidate.entity, action), [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, objectId: candidate.id});
    return true;
  }
  if (action === "traverse") {
    const pending = {
      connectionId: candidate.id,
      arrivalText: String(candidate.entity.arrivalText || "Ты закончил переход."),
      autoCloseAfterTraverse: candidate.entity.autoCloseAfterTraverse === true,
    };
    if (result?.completed) finishTraversal(world, entry, playerIndex, pending);
    else {
      const meta = walkableMeta(entry.instance);
      meta.pendingTraversal[String(playerIndex)] = pending;
      emit(world, "vessel-deck-traversal-start", connectionText(candidate.entity, action), [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, connectionId: candidate.id, duration: result?.duration || 0});
    }
    return true;
  }
  emit(world, `vessel-deck-${action}`, connectionText(candidate.entity, action), [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, connectionId: candidate.id});
  return true;
}

function movementProfile(definition, local) {
  const entities = definition?.deckArchitecture?.entities;
  const zone = local?.zoneId ? entities?.get?.(`zone:${local.deckId}:${local.zoneId}`) : null;
  const deck = entities?.get?.(`deck:${local.deckId}:${local.deckId}`);
  return zone?.movement || deck?.movement || definition?.deckArchitecture?.movement || {speed: 4.5, jumpDistance: 1.8, runJumpMultiplier: 1.6};
}

function removeCrew(boat, playerIndex) {
  if (!Array.isArray(boat?.crew)) return;
  boat.crew = boat.crew.map(value => value === playerIndex ? null : value);
}

function lowerDeckLanding(definition, current, target) {
  const currentDeck = deckFor(definition, current.deckId);
  if (!currentDeck) return null;
  const candidates = (definition.decks || [])
    .filter(deck => Number(deck.level) < Number(currentDeck.level) && pointInShape(target, deck.shape))
    .sort((a, b) => Number(b.level) - Number(a.level));
  const deck = candidates[0];
  return deck ? {deckId: deck.id, x: target.x, y: target.y, heading: current.heading} : null;
}

function jumpFromDeck(world, entry, playerIndex, raw) {
  const local = entry.instance?.occupants?.[playerIndex];
  if (!local || entry.instance?.interior?.traversals?.[playerIndex]) return false;
  const profile = movementProfile(entry.definition, local);
  const multiplier = raw.run ? Number(profile.runJumpMultiplier) || 1.6 : 1;
  const distance = Math.max(0.2, Number(profile.jumpDistance) || 1.8) * multiplier;
  const angle = Number(local.heading) * Math.PI / 180;
  const delta = {x: Math.sin(angle) * distance, y: Math.cos(angle) * distance};
  const result = tryMoveVesselOccupant(entry.definition, entry.instance, playerIndex, delta, {mode: "jump", heading: local.heading});
  if (result.moved) {
    const point = vesselLocalToWorld(entry.boat, result.position);
    emit(world, "jump", "Прыжок по палубе.", [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, x: point.x, y: point.y});
    return true;
  }
  const target = {x: Number(local.x) + delta.x, y: Number(local.y) + delta.y};
  const landing = lowerDeckLanding(entry.definition, local, target);
  if (landing) {
    const next = setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, landing);
    const deck = deckFor(entry.definition, next.deckId);
    const point = vesselLocalToWorld(entry.boat, next);
    emit(world, "jump", `Ты спрыгнул на ${deck?.label || "нижнюю палубу"}.`, [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, deckId: next.deckId, x: point.x, y: point.y});
    return true;
  }
  const worldPoint = vesselLocalToWorld(entry.boat, target);
  clearVesselOccupantPosition(entry.instance, playerIndex);
  removeCrew(entry.boat, playerIndex);
  if (entry.boat.driver === playerIndex) entry.boat.driver = null;
  const player = world.players[playerIndex];
  player.vesselDeckInputOwned = false;
  player.activeBoat = null;
  player.mode = "swim";
  player.running = false;
  player.x = clamp(worldPoint.x, 5, 415);
  player.y = clamp(worldPoint.y, 5, 315);
  player.heading = wrap((Number(entry.boat.heading) || 0) + (Number(local.heading) || 0));
  emit(world, "jump", "Ты спрыгнул с палубы в воду.", [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, x: player.x, y: player.y});
  emit(world, "splash", "", world.players.map((_, index) => index), {sourcePlayer: playerIndex, x: player.x, y: player.y});
  return true;
}

function captureDeckInput({world, registry, nativeVessels, playerIndex, input} = {}) {
  if (!world || !Number.isInteger(playerIndex) || !input) return;
  restoreLegacyAboardPlayers(world, nativeVessels);
  for (const entry of nativeVessels || []) syncControlAuthority(world, entry);
  const entry = entryForPlayer(world, nativeVessels, playerIndex);
  const local = entry?.instance?.occupants?.[playerIndex];
  const player = world.players[playerIndex];
  if (!entry || !local || !entry.definition?.deckArchitecture?.enabled) {
    if (player) player.vesselDeckInputOwned = false;
    return;
  }
  player.vesselDeckInputOwned = true;
  const meta = walkableMeta(entry.instance);
  const raw = {
    up: Boolean(input.up), down: Boolean(input.down), left: Boolean(input.left), right: Boolean(input.right),
    run: Boolean(input.run), jump: Boolean(input.jump), action: Boolean(input.action), attack: Boolean(input.attack),
  };
  meta.inputs[String(playerIndex)] = raw;
  const actionRising = rawHeld(meta, playerIndex, "action", raw.action);
  const jumpRising = rawHeld(meta, playerIndex, "jump", raw.jump);
  const controlling = helmOwner(entry) === playerIndex;

  if (controlling) {
    if (actionRising && contextAction(world, registry, entry, playerIndex)) input.action = false;
    return;
  }

  if (actionRising) contextAction(world, registry, entry, playerIndex);
  if (jumpRising) jumpFromDeck(world, entry, playerIndex, raw);
  suppressDeckControls(input);
  syncControlAuthority(world, entry);
}

function finishPendingTraversals(world, nativeVessels) {
  for (const entry of nativeVessels || []) {
    const meta = walkableMeta(entry.instance);
    for (const [rawIndex, pending] of Object.entries({...meta.pendingTraversal})) {
      if (entry.instance?.interior?.traversals?.[rawIndex]) continue;
      const playerIndex = Number(rawIndex);
      if (!entry.instance?.occupants?.[playerIndex]) { delete meta.pendingTraversal[rawIndex]; continue; }
      finishTraversal(world, entry, playerIndex, pending);
      delete meta.pendingTraversal[rawIndex];
    }
    syncControlAuthority(world, entry);
  }
}

function walkDeckPlayers({world, nativeVessels, dt} = {}) {
  if (!world) return;
  const elapsed = Math.max(0, Number(dt) || 0);
  for (const entry of nativeVessels || []) {
    if (!entry?.definition?.deckArchitecture?.enabled) continue;
    const meta = walkableMeta(entry.instance);
    for (const [rawIndex, local] of Object.entries(entry.instance?.occupants || {})) {
      const playerIndex = Number(rawIndex);
      const player = world.players?.[playerIndex];
      if (!player || player.activeBoat !== entry.boat.id) continue;
      player.vesselDeckInputOwned = true;
      if (helmOwner(entry) === playerIndex || entry.instance?.interior?.traversals?.[rawIndex]) {
        player.running = false;
        continue;
      }
      const raw = meta.inputs[rawIndex] || {};
      let dx = Number(Boolean(raw.right)) - Number(Boolean(raw.left));
      let dy = Number(Boolean(raw.up)) - Number(Boolean(raw.down));
      const length = Math.hypot(dx, dy);
      if (!length || !elapsed) {
        player.running = false;
        player.vesselDeckStepRemaining = Math.max(0, Number(player.vesselDeckStepRemaining) || 0) - elapsed;
        continue;
      }
      dx /= length; dy /= length;
      const profile = movementProfile(entry.definition, local);
      const running = Boolean(raw.run);
      const speed = Math.max(0.1, Number(profile.speed) || 4.5) * (running ? 1.55 : 1);
      const heading = wrap(Math.atan2(dx, dy) * 180 / Math.PI);
      const result = tryMoveVesselOccupant(entry.definition, entry.instance, playerIndex, {x: dx * speed * elapsed, y: dy * speed * elapsed}, {heading});
      player.running = running && result.moved;
      if (!result.moved) {
        const previous = Number(meta.edgeAt[rawIndex]) || -999;
        if ((Number(world.time) || 0) - previous >= 0.8) {
          meta.edgeAt[rawIndex] = Number(world.time) || 0;
          emit(world, "vessel-deck-edge", "Край палубы.", [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, deckId: local.deckId});
        }
        continue;
      }
      player.vesselDeckStepRemaining = Math.max(0, Number(player.vesselDeckStepRemaining) || 0) - elapsed;
      if (player.vesselDeckStepRemaining <= 0) {
        player.vesselDeckStepRemaining = running ? 0.29 : 0.42;
        const point = vesselLocalToWorld(entry.boat, result.position);
        emit(world, "footstep", "", world.players.map((_, index) => index), {
          sourcePlayer: playerIndex,
          boatId: entry.boat.id,
          deckId: result.position.deckId,
          x: point.x,
          y: point.y,
          heading: wrap((Number(entry.boat.heading) || 0) + heading),
          movementPan: clamp(dx, -1, 1),
          vesselDeck: true,
        });
      }
    }
    syncControlAuthority(world, entry);
  }
}

function afterInput(context) {
  normalizeBoardingEvents(context);
  for (const entry of context?.nativeVessels || []) syncControlAuthority(context.world, entry);
}

function beforeStep(context) {
  restoreLegacyAboardPlayers(context.world, context.nativeVessels);
  finishPendingTraversals(context.world, context.nativeVessels);
}

function afterStep(context) {
  normalizeBoardingEvents(context);
  walkDeckPlayers(context);
}

export const WALKABLE_VESSEL_SYSTEMS = Object.freeze([
  Object.freeze({id: "walkable-vessel-before-input-v1", phase: "before-input", order: 5, run: captureDeckInput}),
  Object.freeze({id: "walkable-vessel-after-input-v1", phase: "after-input", order: 5, run: afterInput}),
  Object.freeze({id: "walkable-vessel-before-step-v1", phase: "before-step", order: 5, run: beforeStep}),
  Object.freeze({id: "walkable-vessel-after-step-v1", phase: "after-step", order: 5, run: afterStep}),
]);
