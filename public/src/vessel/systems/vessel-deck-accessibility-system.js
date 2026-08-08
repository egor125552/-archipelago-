"use strict";

import {listVesselDeckActions} from "../vessel-deck-runtime.js";

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function deckFor(definition, deckId) {
  return (definition?.decks || []).find(deck => deck.id === deckId) || null;
}

function zoneFor(definition, deckId, zoneId) {
  return (deckFor(definition, deckId)?.zones || []).find(zone => zone.id === zoneId) || null;
}

function stateFor(instance) {
  instance.interior ||= {};
  instance.interior.accessibility ||= {
    zoneByPlayer: {},
    seenZonesByPlayer: {},
    actionPromptByPlayer: {},
  };
  const state = instance.interior.accessibility;
  state.zoneByPlayer ||= {};
  state.seenZonesByPlayer ||= {};
  state.actionPromptByPlayer ||= {};
  return state;
}

function announcementMode(definition, deckId, zoneId) {
  if (!zoneId) return "silent";
  return definition?.deckArchitecture?.entities?.get?.(`zone:${deckId}:${zoneId}`)?.announcement?.mode || "zone-change";
}

function announceZone(world, entry, playerIndex, state) {
  const key = String(playerIndex);
  const occupant = entry.instance?.occupants?.[key];
  if (!occupant) return;
  const currentKey = `${occupant.deckId}:${occupant.zoneId || ""}`;
  const previousKey = state.zoneByPlayer[key];
  if (previousKey === currentKey) return;

  const seen = state.seenZonesByPlayer[key] ||= {};
  if (previousKey) {
    const [previousDeckId, previousZoneId] = previousKey.split(":");
    if (previousZoneId && announcementMode(entry.definition, previousDeckId, previousZoneId) === "entry-exit") {
      const previousZone = zoneFor(entry.definition, previousDeckId, previousZoneId);
      if (previousZone) {
        emit(world, "vessel-deck-zone-exit", `Выход из зоны: ${previousZone.label}.`, [playerIndex], {
          sourcePlayer: playerIndex,
          boatId: entry.boat.id,
          deckId: previousDeckId,
          zoneId: previousZoneId,
        });
      }
    }
  }

  const zoneId = occupant.zoneId || null;
  const zone = zoneId ? zoneFor(entry.definition, occupant.deckId, zoneId) : null;
  const mode = announcementMode(entry.definition, occupant.deckId, zoneId);
  const marker = currentKey;
  const shouldAnnounce = Boolean(zone) && (
    mode === "every-entry"
    || mode === "entry-exit"
    || mode === "zone-change"
    || (mode === "first-entry" && seen[marker] !== true)
  );
  if (shouldAnnounce) {
    emit(world, "vessel-deck-zone-enter", `Зона: ${zone.label}.`, [playerIndex], {
      sourcePlayer: playerIndex,
      boatId: entry.boat.id,
      deckId: occupant.deckId,
      zoneId,
    });
  }
  if (zone && mode !== "silent") seen[marker] = true;
  state.zoneByPlayer[key] = currentKey;
}

function distanceTo(occupant, point) {
  return Math.hypot((Number(occupant?.x) || 0) - (Number(point?.x) || 0), (Number(occupant?.y) || 0) - (Number(point?.y) || 0));
}

function interactionCandidates(registry, entry, playerIndex) {
  const occupant = entry.instance?.occupants?.[playerIndex];
  const deck = occupant ? deckFor(entry.definition, occupant.deckId) : null;
  if (!occupant || !deck) return [];
  const candidates = [];
  for (const connection of deck.connections || []) {
    const actions = listVesselDeckActions(registry, entry.definition, entry.instance, playerIndex, {kind: "connection", id: connection.id});
    if (actions.length) candidates.push({kind: "connection", id: connection.id, entity: connection, actions, distance: distanceTo(occupant, connection.from)});
  }
  for (const object of deck.objects || []) {
    const actions = listVesselDeckActions(registry, entry.definition, entry.instance, playerIndex, {kind: "object", id: object.id});
    if (actions.length) candidates.push({kind: "object", id: object.id, entity: object, actions, distance: distanceTo(occupant, object.position)});
  }
  return candidates.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
}

function preferredAction(candidate) {
  const byId = new Map((candidate?.actions || []).map(action => [action.id, action]));
  if (candidate?.kind === "object") return byId.get("leave") || byId.get("occupy") || candidate.actions[0] || null;
  if (candidate?.kind === "connection") return byId.get("open") || byId.get("traverse") || byId.get("close") || candidate.actions[0] || null;
  return candidate?.actions?.[0] || null;
}

function recentDeckAction(world, playerIndex) {
  const now = Number(world?.time) || 0;
  for (let index = (world?.events || []).length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (now - (Number(event?.at) || 0) > 0.3) break;
    if (event?.sourcePlayer !== playerIndex) continue;
    if (String(event.type || "").startsWith("vessel-deck-") && !["vessel-deck-zone-enter", "vessel-deck-zone-exit", "vessel-deck-action-available"].includes(event.type)) return true;
  }
  return false;
}

function announceAvailableAction(world, registry, entry, playerIndex, state) {
  const key = String(playerIndex);
  if (entry.instance?.interior?.traversals?.[key]) {
    delete state.actionPromptByPlayer[key];
    return;
  }
  const candidate = interactionCandidates(registry, entry, playerIndex)[0] || null;
  const action = preferredAction(candidate);
  if (!candidate || !action) {
    delete state.actionPromptByPlayer[key];
    return;
  }
  const promptKey = `${entry.instance.occupants[key]?.deckId || ""}:${candidate.kind}:${candidate.id}:${action.id}`;
  if (state.actionPromptByPlayer[key] === promptKey || recentDeckAction(world, playerIndex)) return;
  state.actionPromptByPlayer[key] = promptKey;
  emit(world, "vessel-deck-action-available", `Рядом: ${candidate.entity.label}. Доступно: ${action.label}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: entry.boat.id,
    deckId: entry.instance.occupants[key]?.deckId || null,
    targetKind: candidate.kind,
    targetId: candidate.id,
    actionId: action.id,
  });
}

function updateDeckAccessibility({world, registry, nativeVessels} = {}) {
  if (!world || !registry) return;
  for (const entry of nativeVessels || []) {
    if (!entry?.definition?.deckArchitecture?.enabled) continue;
    const state = stateFor(entry.instance);
    const activePlayers = new Set();
    for (const rawIndex of Object.keys(entry.instance?.occupants || {})) {
      const playerIndex = Number(rawIndex);
      const player = world.players?.[playerIndex];
      if (!Number.isInteger(playerIndex) || !player || player.activeBoat !== entry.boat.id) continue;
      activePlayers.add(rawIndex);
      announceZone(world, entry, playerIndex, state);
      announceAvailableAction(world, registry, entry, playerIndex, state);
    }
    for (const key of Object.keys(state.zoneByPlayer)) if (!activePlayers.has(key)) delete state.zoneByPlayer[key];
    for (const key of Object.keys(state.actionPromptByPlayer)) if (!activePlayers.has(key)) delete state.actionPromptByPlayer[key];
  }
}

export const VESSEL_DECK_ACCESSIBILITY_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-deck-accessibility-v1",
    phase: "after-step",
    order: 25,
    run: updateDeckAccessibility,
  }),
]);
