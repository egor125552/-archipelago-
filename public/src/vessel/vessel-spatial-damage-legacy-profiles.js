"use strict";

import {VESSEL_SPATIAL_DAMAGE_VERSION, clamp, finite, values} from "./vessel-spatial-damage-core.js?v=1";

export function sourceById(world, id) {
  if (!id) return null;
  const pools = [
    [world?.freeActivities?.marauder],
    world?.freePursuerSquad?.escorts,
    world?.freeEnemyBoats?.boats,
    world?.freeHostileGunners?.gunners,
    world?.freeHostileActors?.actors,
    [world?.freeHeavyPursuer?.boat],
    [world?.freeEliteBoatBoss?.boat],
  ];
  for (const pool of pools) {
    const found = values(pool).find(item => String(item?.id) === String(id) || String(item?.gunnerId) === String(id));
    if (found) return found;
  }
  return null;
}

export function legacyProfile(world, event) {
  if (event?.type === "heavy-bullet-boat-hit") return {kind: "heavy-bullet", hull: 5.5, leak: 0.22, damage: 13.5, playerDamage: 6, source: world?.freeHeavyPursuer?.boat};
  if (event?.type === "elite-ram-impact") return {kind: "ram", hull: Math.max(0, finite(event.targetDamage, 20)), leak: 1.8, damage: Math.max(20, finite(event.targetDamage, 20) * 2.8), playerDamage: 10, source: world?.freeEliteBoatBoss?.boat};
  if (event?.type === "heavy-ram-hit") {
    const source = world?.freeHeavyPursuer?.boat;
    const originalSpeed = Math.max(5, finite(source?.speed) / 0.6);
    const impact = 14 + originalSpeed * 1.4;
    return {kind: "ram", hull: impact * 0.55, leak: impact * 0.055, damage: impact * 1.5, playerDamage: impact * 0.3, source};
  }
  if (event?.type === "enemy-ram-hit") {
    const source = sourceById(world, event.sourcePursuerId);
    const originalSpeed = Math.max(0, finite(source?.speed) / 0.55);
    const impact = Math.max(8, originalSpeed * 1.35);
    return {kind: "ram", hull: impact * 0.45, leak: impact * 0.04, damage: impact * 1.3, playerDamage: impact * 0.22, source};
  }
  if (event?.type === "enemy-bullet-boat-hit") {
    if (event.gunnerId) {
      const source = sourceById(world, event.gunnerId);
      if (source?.weapon === "pistol") return {kind: "bullet", hull: 2, leak: 0.08, damage: 5.2, playerDamage: 5, source};
      if (source?.weapon === "automatic") return {kind: "bullet", hull: 3, leak: 0.12, damage: 7.2, playerDamage: 4, source};
      return {kind: "bullet", hull: 3, leak: 0.14, damage: 7.2, playerDamage: 4, source};
    }
    if (String(event.sourcePursuerId || "").startsWith("threat-boat-")) return {kind: "bullet", hull: 2.5, leak: 0.1, damage: 6.4, playerDamage: 4, source: sourceById(world, event.sourcePursuerId)};
    return {kind: "bullet", hull: Math.max(0.1, finite(event.damage, 1.5)), leak: 0.22, damage: Math.max(4, finite(event.damage, 1.5) * 2.6), playerDamage: 4, source: sourceById(world, event.sourcePursuerId)};
  }
  return null;
}

export function undoLegacyBoatDamage(entry, profile) {
  const boat = entry.boat;
  const hullMax = Math.max(1, finite(boat.hullMax, 100));
  boat.hull = clamp(finite(boat.hull) + Math.max(0, finite(profile.hull)), 0, hullMax);
  boat.leak = Math.max(0, finite(boat.leak) - Math.max(0, finite(profile.leak)));
  if (profile.water) boat.water = Math.max(0, finite(boat.water) - Math.max(0, finite(profile.water)));
}

export function attachImpact(event, result) {
  if (!event || !result) return;
  event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
  event.deckId = result.deckId;
  event.deckLabel = result.deckLabel;
  event.zoneId = result.zoneId;
  event.zoneLabel = result.zoneLabel;
  event.armorDamage = Math.round(result.armorDamage * 10) / 10;
  event.armor = Math.round(result.armor * 10) / 10;
  event.hull = result.hull;
  event.hullDamage = Math.round(result.hullDamage * 10) / 10;
  event.moduleHits = result.modules.map(item => ({moduleId: item.moduleId, damage: Math.round(item.damage * 10) / 10, health: Math.round(item.health * 10) / 10, disabled: item.disabled}));
  if (typeof event.text === "string" && event.text.trim()) {
    const armorText = result.armorDamage > 0 ? ` Броня ${Math.round(result.armor)}.` : "";
    event.text = `${result.deckLabel}: попадание. Корпус ${Math.round(result.hull)}.${armorText}`;
  }
}
