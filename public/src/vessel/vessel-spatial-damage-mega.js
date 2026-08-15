"use strict";

import {worldToVesselLocal} from "./vessel-interior.js";
import {VESSEL_SPATIAL_DAMAGE_VERSION, applySpatialVesselImpact, clamp, distance, finite, freshEvents, snapshotFor, values} from "./vessel-spatial-damage-core.js?v=1";
import {attachImpact, compensateLegacyPlayerDamage, undoLegacyBoatDamage} from "./vessel-spatial-damage-legacy.js?v=1";
import {normalizeMegaBombOccupantEffects, refreshMegaBombExplosionCounts} from "./vessel-spatial-damage-mega-player.js?v=1";

export function reconcileMegaBombVesselSpatialDamage(world, eventStart, nativeVessels, state = null) {
  if (!world) return;
  const entries = new Map(values(nativeVessels).map(entry => [String(entry?.boat?.id), entry]));
  const events = freshEvents(world, eventStart || 0, "mega-bomb");
  const explosions = events.filter(event => event?.type === "mega-bomb-explosion");
  for (const event of events.filter(event => event?.type === "mega-bomb-boat-hit" && event.boatId != null)) {
    const entry = entries.get(String(event.boatId));
    if (!entry?.definition?.capabilities?.zonalDamage || entry.definition?.damage?.mode !== "zonal") continue;
    const legacyRaw = Math.max(0, finite(event.damage) / 0.55);
    const legacyHull = Math.max(0, finite(event.damage));
    const legacyLeak = legacyRaw * 0.045;
    const legacyWater = legacyRaw * 0.08;
    undoLegacyBoatDamage(entry, {hull: legacyHull, leak: legacyLeak, water: legacyWater});
    const explosion = explosions.find(item => String(item.projectileId || "") === String(event.projectileId || ""));
    const result = applySpatialVesselImpact(world, entry, {
      kind: "blast",
      damage: legacyRaw,
      playerDamage: legacyRaw * 0.46,
      impactPoint: {x: finite(explosion?.x, event.x), y: finite(explosion?.y, event.y)},
      impactHeight: finite(explosion?.z, 0),
      fromAbove: String(explosion?.reason || "").includes("impact") && finite(explosion?.z) > 1.2,
      projectileId: event.projectileId,
      sourceId: `mega-bomb:${event.sourcePlayer}`,
      weapon: "mega-bomb",
      preferTargetDeck: false,
      damagePlayers: false,
    });
    attachImpact(event, result);
    if (result) {
      event.text = result.armorDamage > 0
        ? `Мега-бомба: ${result.deckLabel}. Броня ${Math.round(result.armor)}, корпус ${Math.round(result.hull)}.`
        : `Мега-бомба: ${result.deckLabel}. Корпус ${Math.round(result.hull)}.`;
    }
  }
  // Player blast damage is still produced by the legacy explosion code. Correct
  // only players who are physically aboard a zonal vessel; people ashore keep
  // the existing blast model.
  for (const event of events.filter(item => item?.type === "mega-bomb-player-hit" && Number.isInteger(item.targetPlayer))) {
    const before = snapshotFor(world, "mega-bomb")?.players?.[event.targetPlayer];
    const boatId = before?.activeBoat;
    const entry = entries.get(String(boatId));
    if (!entry?.definition?.capabilities?.zonalDamage) continue;
    const eventIndex = events.indexOf(event);
    const nextExplosionIndex = events.findIndex((item, index) => index > eventIndex && item?.type === "mega-bomb-explosion");
    const endIndex = nextExplosionIndex >= 0 ? nextExplosionIndex + 1 : events.length;
    const boatEvent = events.slice(eventIndex + 1, endIndex).find(item => (
      item?.type === "mega-bomb-boat-hit"
      && String(item.boatId) === String(boatId)
      && Number(item.sourcePlayer) === Number(event.sourcePlayer)
    ));
    const explosion = boatEvent
      ? explosions.find(item => String(item.projectileId || "") === String(boatEvent.projectileId || ""))
      : (nextExplosionIndex >= 0 ? events[nextExplosionIndex] : null);
    if (boatEvent?.projectileId != null) event.projectileId = boatEvent.projectileId;
    const local = entry.instance?.occupants?.[event.targetPlayer] || snapshotFor(world, "mega-bomb")?.boats?.get(String(boatId))?.occupants?.[event.targetPlayer];
    const deck = values(entry.definition.decks).find(item => item.id === boatEvent?.deckId);
    const localImpact = boatEvent?.deckId && explosion
      ? worldToVesselLocal(entry.boat, {x: finite(explosion.x, entry.boat.x), y: finite(explosion.y, entry.boat.y)})
      : null;
    const sameDeck = local && deck && local.deckId === deck.id;
    const protection = sameDeck && localImpact ? clamp(1 - distance(local, localImpact) / 10, 0.18, 0.75) : 0.06;
    const legacyDamage = finite(event.damage);
    const correctDamage = legacyDamage * protection;
    compensateLegacyPlayerDamage(world, entry, event.targetPlayer, legacyDamage, correctDamage, {
      weapon: "mega-bomb", heavy: true, sourcePoint: explosion || null,
    }, "mega-bomb");
    const spatialStunned = normalizeMegaBombOccupantEffects(world, entry, event, before, local, deck, localImpact, correctDamage, explosion);
    event.legacyDamage = legacyDamage;
    event.damage = correctDamage;
    event.health = world.players?.[event.targetPlayer]?.combat?.health;
    event.spatialDamage = Math.round(correctDamage * 10) / 10;
    event.spatialStunned = spatialStunned;
    event.deckId = deck?.id || null;
    event.zoneId = boatEvent?.zoneId || null;
    event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
    if (correctDamage <= 1) {
      const liveIndex = world.events.indexOf(event);
      if (liveIndex >= 0) world.events.splice(liveIndex, 1);
    }
  }
  refreshMegaBombExplosionCounts(world, events, explosions);
  return state;
}
