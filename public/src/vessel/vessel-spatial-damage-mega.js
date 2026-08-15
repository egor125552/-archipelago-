"use strict";

import {worldToVesselLocal} from "./vessel-interior.js";
import {
  VESSEL_SPATIAL_DAMAGE_VERSION, applySpatialVesselImpact, clamp, distance, emit, finite, freshEvents, snapshotFor, values,
} from "./vessel-spatial-damage-core.js?v=1";
import {attachImpact, compensateLegacyPlayerDamage, undoLegacyBoatDamage} from "./vessel-spatial-damage-legacy.js?v=1";

function removeMegaBombStunEvents(world, playerIndex, projectileId) {
  for (let index = world.events.length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (!event || !["mega-bomb-stun", "mega-bomb-stun-notice"].includes(event.type)) continue;
    if (Number(event.targetPlayer) !== playerIndex || String(event.projectileId || "") !== String(projectileId || "")) continue;
    world.events.splice(index, 1);
  }
}

function normalizeMegaBombOccupantEffects(world, entry, event, before, local, deck, localImpact, correctDamage, explosion) {
  const player = world?.players?.[event.targetPlayer];
  if (!player?.combat || !before) return false;
  const sameDeck = Boolean(local && deck && local.deckId === deck.id && localImpact);
  const internalDistance = sameDeck ? distance(local, localImpact) : Infinity;
  const spatialStunned = Boolean(player.combat.alive && correctDamage > 1 && sameDeck && internalDistance <= 8.5);
  player.combat.stun = clamp(before.stun + Math.max(0, correctDamage) * 2.4, 0, 100);
  if (!before.knockedDown) {
    const critical = player.combat.alive && finite(player.combat.health) > 0 && finite(player.combat.health) <= 7;
    player.combat.knockedDown = spatialStunned || critical;
    player.combat.knockdownRemaining = spatialStunned ? Math.max(before.knockdownRemaining, clamp(1.1 + correctDamage / 55, 1.2, 4.8)) : critical ? Math.max(before.knockdownRemaining, 2.2) : before.knockdownRemaining;
  }
  removeMegaBombStunEvents(world, event.targetPlayer, event.projectileId);
  if (spatialStunned && !before.knockedDown) {
    emit(world, "mega-bomb-stun", "", [event.targetPlayer], {sourcePlayer: event.sourcePlayer, targetPlayer: event.targetPlayer, projectileId: event.projectileId, x: explosion?.x ?? entry.boat.x, y: explosion?.y ?? entry.boat.y, damage: Math.round(correctDamage)});
    emit(world, "mega-bomb-stun-notice", "Ударная волна внутри отсека сбила тебя с ног.", [event.targetPlayer], {sourcePlayer: event.sourcePlayer, targetPlayer: event.targetPlayer, projectileId: event.projectileId});
  }
  return spatialStunned;
}

function refreshMegaBombExplosionCounts(world, events, explosions) {
  const snapshot = snapshotFor(world, "mega-bomb");
  for (const explosion of explosions) {
    const projectileId = String(explosion.projectileId || "");
    const correctedEvents = events.filter(event => (
      event?.type === "mega-bomb-player-hit"
      && event.spatialVesselCorrected === true
      && String(event.projectileId || "") === projectileId
    ));
    if (!correctedEvents.length) continue;

    const legacyHits = correctedEvents.filter(event => event.legacyHit === true).length;
    const legacyDeaths = correctedEvents.filter(event => event.legacyDeath === true).length;
    const legacyStuns = correctedEvents.filter(event => event.legacyStunned === true).length;
    const correctedHits = correctedEvents.filter(event => finite(event.damage) > 1);
    const correctedDeaths = correctedHits.filter(event => {
      const playerIndex = Number(event.targetPlayer);
      return snapshot?.players?.[playerIndex]?.alive && world.players?.[playerIndex]?.combat?.alive === false;
    }).length;
    const correctedStuns = correctedHits.filter(event => event.spatialStunned === true).length;
    const hitDelta = correctedHits.length - legacyHits;

    explosion.hitCount = Math.max(0, finite(explosion.hitCount) + hitDelta);
    explosion.playerHitCount = Math.max(0, finite(explosion.playerHitCount) + hitDelta);
    explosion.playerDeathCount = Math.max(0, finite(explosion.playerDeathCount) + correctedDeaths - legacyDeaths);
    explosion.stunnedCount = Math.max(0, finite(explosion.stunnedCount) + correctedStuns - legacyStuns);
    if (explosion.hitCount > 0) explosion.text = `Взрыв поразил объектов: ${explosion.hitCount}. Противников уничтожено: ${Math.max(0, finite(explosion.destroyedCount))}.`;
    else if (finite(explosion.blockedCount) > 0) explosion.text = "Твёрдый берег или корпус судна ослабил ударную волну.";
    else explosion.text = "Взрыв не задел цели.";
    explosion.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
  }
}

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
      kind: "blast", damage: legacyRaw, playerDamage: legacyRaw * 0.46,
      impactPoint: {x: finite(explosion?.x, event.x), y: finite(explosion?.y, event.y)},
      impactHeight: finite(explosion?.z, 0), fromAbove: String(explosion?.reason || "").includes("impact") && finite(explosion?.z) > 1.2,
      projectileId: event.projectileId, sourceId: `mega-bomb:${event.sourcePlayer}`, weapon: "mega-bomb", preferTargetDeck: false, damagePlayers: false,
    });
    attachImpact(event, result);
    if (result) event.text = result.armorDamage > 0 ? `Мега-бомба: ${result.deckLabel}. Броня ${Math.round(result.armor)}, корпус ${Math.round(result.hull)}.` : `Мега-бомба: ${result.deckLabel}. Корпус ${Math.round(result.hull)}.`;
  }
  for (const event of events.filter(item => item?.type === "mega-bomb-player-hit" && Number.isInteger(item.targetPlayer))) {
    const before = snapshotFor(world, "mega-bomb")?.players?.[event.targetPlayer];
    const boatId = before?.activeBoat;
    const entry = entries.get(String(boatId));
    if (!entry?.definition?.capabilities?.zonalDamage) continue;
    const eventIndex = events.indexOf(event);
    const nextExplosionIndex = events.findIndex((item, index) => index > eventIndex && item?.type === "mega-bomb-explosion");
    const endIndex = nextExplosionIndex >= 0 ? nextExplosionIndex + 1 : events.length;
    const boatEvent = events.slice(eventIndex + 1, endIndex).find(item => item?.type === "mega-bomb-boat-hit" && String(item.boatId) === String(boatId) && Number(item.sourcePlayer) === Number(event.sourcePlayer));
    const explosion = boatEvent ? explosions.find(item => String(item.projectileId || "") === String(boatEvent.projectileId || "")) : (nextExplosionIndex >= 0 ? events[nextExplosionIndex] : null);
    if (boatEvent?.projectileId != null) event.projectileId = boatEvent.projectileId;
    const local = entry.instance?.occupants?.[event.targetPlayer] || snapshotFor(world, "mega-bomb")?.boats?.get(String(boatId))?.occupants?.[event.targetPlayer];
    const deck = values(entry.definition.decks).find(item => item.id === boatEvent?.deckId);
    const localImpact = boatEvent?.deckId && explosion ? worldToVesselLocal(entry.boat, {x: finite(explosion.x, entry.boat.x), y: finite(explosion.y, entry.boat.y)}) : null;
    const sameDeck = local && deck && local.deckId === deck.id;
    const protection = sameDeck && localImpact ? clamp(1 - distance(local, localImpact) / 10, 0.18, 0.75) : 0.06;
    const legacyDamage = finite(event.damage);
    const legacyPlayer = world.players?.[event.targetPlayer];
    const legacyAliveAfter = legacyPlayer?.combat?.alive !== false;
    const legacyKnockedDownAfter = Boolean(legacyPlayer?.combat?.knockedDown);
    const legacyHit = legacyDamage > 1;
    const legacyDeath = Boolean(before?.alive && !legacyAliveAfter);
    const legacyStunned = Boolean(before && !before.knockedDown && legacyKnockedDownAfter);
    const correctDamage = legacyDamage * protection;
    compensateLegacyPlayerDamage(world, entry, event.targetPlayer, legacyDamage, correctDamage, {weapon: "mega-bomb", heavy: true, sourcePoint: explosion || null}, "mega-bomb");
    const spatialStunned = normalizeMegaBombOccupantEffects(world, entry, event, before, local, deck, localImpact, correctDamage, explosion);
    event.legacyDamage = legacyDamage;
    event.legacyHit = legacyHit;
    event.legacyDeath = legacyDeath;
    event.legacyStunned = legacyStunned;
    event.damage = correctDamage;
    event.health = world.players?.[event.targetPlayer]?.combat?.health;
    event.spatialDamage = Math.round(correctDamage * 10) / 10;
    event.spatialStunned = spatialStunned;
    event.spatialVesselCorrected = true;
    event.deckId = deck?.id || null;
    event.zoneId = boatEvent?.zoneId || null;
    event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
    if (correctDamage <= 1) { const liveIndex = world.events.indexOf(event); if (liveIndex >= 0) world.events.splice(liveIndex, 1); }
  }
  refreshMegaBombExplosionCounts(world, events, explosions);
  return state;
}
