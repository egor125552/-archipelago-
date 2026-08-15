"use strict";

import {VESSEL_SPATIAL_DAMAGE_VERSION, applySpatialVesselImpact, finite, freshEvents, occupantDamageScale, snapshotFor, values} from "./vessel-spatial-damage-core.js?v=1";
import {attachImpact, undoLegacyBoatDamage} from "./vessel-spatial-damage-legacy-profiles.js?v=1";
import {compensateLegacyPlayerDamage} from "./vessel-spatial-damage-legacy-reconcile.js?v=1";

export function reconcileElitePenetrationSpatialDamage(context = {}) {
  const world = context.world;
  if (!world) return;
  const entries = new Map((context.nativeVessels || []).map(entry => [String(entry?.boat?.id), entry]));
  const events = freshEvents(world, context.eventStart || 0, "world-step").filter(event => event?.type === "elite-bullet-penetration" && event.targetBoat != null);
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.projectileId}:${event.targetBoat}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  for (const group of grouped.values()) {
    const first = group[0];
    const entry = entries.get(String(first.targetBoat));
    if (!entry?.definition?.capabilities?.zonalDamage || entry.definition?.damage?.mode !== "zonal") continue;
    const legacyHull = Math.max(0, finite(first.hullDamage, 2.8));
    undoLegacyBoatDamage(entry, {hull: legacyHull, leak: 0.12});
    const source = world?.freeEliteBoatBoss?.boat;
    const result = applySpatialVesselImpact(world, entry, {
      kind: "heavy-bullet",
      damage: Math.max(8, legacyHull / Math.max(0.1, finite(entry.definition?.damage?.hullShare, 0.25))),
      playerDamage: 7.2,
      sourcePoint: source,
      impactPoint: {x: finite(first.x, entry.boat.x), y: finite(first.y, entry.boat.y)},
      projectileId: first.projectileId,
      sourceId: first.turretId,
      weapon: "elite-automatic",
      preferTargetDeck: false,
      damagePlayers: false,
    });
    attachImpact(first, result);
    for (const event of group) {
      const local = entry.instance?.occupants?.[event.targetPlayer] || snapshotFor(world, "world-step")?.boats?.get(String(entry.boat.id))?.occupants?.[event.targetPlayer];
      const correctScale = local && result ? occupantDamageScale(entry, local, values(entry.definition.decks).find(deck => deck.id === result.deckId), result.localImpact, {kind: "heavy-bullet"}, result.transmission) : 0;
      const correctDamage = 7.2 * correctScale;
      const legacyDamage = finite(event.humanDamage, 7.2);
      compensateLegacyPlayerDamage(world, entry, Number(event.targetPlayer), legacyDamage, correctDamage, {
        weapon: "elite-automatic", heavy: true, sourcePoint: source,
      });
      event.legacyHumanDamage = legacyDamage;
      event.humanDamage = correctDamage;
      event.health = world.players?.[event.targetPlayer]?.combat?.health;
      event.spatialHumanDamage = Math.round(correctDamage * 10) / 10;
      event.deckId = result?.deckId || null;
      event.zoneId = result?.zoneId || null;
      event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
    }
  }
}
