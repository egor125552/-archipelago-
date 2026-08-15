"use strict";

import {VESSEL_SPATIAL_DAMAGE_VERSION, clamp, distance, emit, finite, snapshotFor} from "./vessel-spatial-damage-core.js?v=1";

function removeMegaBombStunEvents(world, playerIndex, projectileId) {
  for (let index = world.events.length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (!event || !["mega-bomb-stun", "mega-bomb-stun-notice"].includes(event.type)) continue;
    if (Number(event.targetPlayer) !== playerIndex || String(event.projectileId || "") !== String(projectileId || "")) continue;
    world.events.splice(index, 1);
  }
}

export function normalizeMegaBombOccupantEffects(world, entry, event, before, local, deck, localImpact, correctDamage, explosion) {
  const player = world?.players?.[event.targetPlayer];
  if (!player?.combat || !before) return false;
  const sameDeck = Boolean(local && deck && local.deckId === deck.id && localImpact);
  const internalDistance = sameDeck ? distance(local, localImpact) : Infinity;
  const spatialStunned = Boolean(player.combat.alive && correctDamage > 1 && sameDeck && internalDistance <= 8.5);
  player.combat.stun = clamp(before.stun + Math.max(0, correctDamage) * 2.4, 0, 100);
  if (!before.knockedDown) {
    const critical = player.combat.alive && finite(player.combat.health) > 0 && finite(player.combat.health) <= 7;
    player.combat.knockedDown = spatialStunned || critical;
    player.combat.knockdownRemaining = spatialStunned
      ? Math.max(before.knockdownRemaining, clamp(1.1 + correctDamage / 55, 1.2, 4.8))
      : critical ? Math.max(before.knockdownRemaining, 2.2) : before.knockdownRemaining;
  }
  removeMegaBombStunEvents(world, event.targetPlayer, event.projectileId);
  if (spatialStunned && !before.knockedDown) {
    emit(world, "mega-bomb-stun", "", [event.targetPlayer], {
      sourcePlayer: event.sourcePlayer,
      targetPlayer: event.targetPlayer,
      projectileId: event.projectileId,
      x: explosion?.x ?? entry.boat.x,
      y: explosion?.y ?? entry.boat.y,
      damage: Math.round(correctDamage),
    });
    emit(world, "mega-bomb-stun-notice", "Ударная волна внутри отсека сбила тебя с ног.", [event.targetPlayer], {
      sourcePlayer: event.sourcePlayer,
      targetPlayer: event.targetPlayer,
      projectileId: event.projectileId,
    });
  }
  return spatialStunned;
}

export function refreshMegaBombExplosionCounts(world, events, explosions) {
  const snapshot = snapshotFor(world, "mega-bomb");
  for (const explosion of explosions) {
    const projectileId = String(explosion.projectileId || "");
    const playerEvents = events.filter(event => event?.type === "mega-bomb-player-hit" && String(event.projectileId || "") === projectileId);
    const correctedHits = playerEvents.filter(event => finite(event.damage) > 1);
    const correctedDeaths = correctedHits.filter(event => {
      const playerIndex = Number(event.targetPlayer);
      return snapshot?.players?.[playerIndex]?.alive && world.players?.[playerIndex]?.combat?.alive === false;
    }).length;
    const correctedStuns = correctedHits.filter(event => event.spatialStunned === true).length;
    const legacyPlayerHits = Math.max(0, finite(explosion.playerHitCount));
    explosion.hitCount = Math.max(0, finite(explosion.hitCount) - legacyPlayerHits + correctedHits.length);
    explosion.playerHitCount = correctedHits.length;
    explosion.playerDeathCount = correctedDeaths;
    explosion.stunnedCount = correctedStuns;
    if (explosion.hitCount > 0) {
      explosion.text = `Взрыв поразил объектов: ${explosion.hitCount}. Противников уничтожено: ${Math.max(0, finite(explosion.destroyedCount))}.`;
    } else if (finite(explosion.blockedCount) > 0) {
      explosion.text = "Твёрдый берег или корпус судна ослабил ударную волну.";
    } else {
      explosion.text = "Взрыв не задел цели.";
    }
    explosion.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
  }
}
