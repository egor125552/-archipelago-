"use strict";

import {dropCarriedCrate} from "../free-roam-activities.js?v=44";
import {applyCombatDamage} from "../free-roam-combat-v2.js?v=6";
import {setVesselOccupantPosition} from "./vessel-interior.js";
import {
  VESSEL_SPATIAL_DAMAGE_VERSION, applySpatialVesselImpact, clamp, emit, finite, freshEvents,
  modulePosition, moduleUserLabel, occupantDamageScale, snapshotFor, values,
} from "./vessel-spatial-damage-core.js?v=1";

function sourceById(world, id) {
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

function legacyProfile(world, event) {
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

function inputAttack(world, playerIndex) {
  return Boolean(world?.freeActivities?.inputs?.[playerIndex]?.attack || world?.operationInputs?.[playerIndex]?.attack || world?.inputs?.[playerIndex]?.attack);
}

function mountedModulesBySide(entry) {
  const mounted = values(entry?.definition?.modules).filter(module => module?.type === "mounted-weapon");
  return mounted.sort((left, right) => {
    const leftPosition = modulePosition(entry, left.id)?.position || {x: 0};
    const rightPosition = modulePosition(entry, right.id)?.position || {x: 0};
    return finite(leftPosition.x) - finite(rightPosition.x);
  });
}

function syncLegacyMountedWeapons(world, entry, announceInput = false) {
  const controller = world?.freeDualTurretBoat;
  if (!controller || String(controller.boatId) !== String(entry?.boat?.id) || !Array.isArray(controller.turrets)) return;
  const modules = mountedModulesBySide(entry);
  if (!modules.length) return;
  const turrets = [...controller.turrets].sort((left, right) => finite(left?.side) - finite(right?.side));
  for (let index = 0; index < Math.min(modules.length, turrets.length); index += 1) {
    const module = entry.instance?.modules?.[modules[index].id];
    const turret = turrets[index];
    if (!module || !turret) continue;
    const disabled = module.enabled === false || finite(module.health, 100) <= 0;
    if (disabled) {
      if (!turret.spatialDisabled && Number.isFinite(Number(turret.cooldown))) turret.spatialCooldownBeforeDisable = Math.max(0, Number(turret.cooldown) || 0);
      turret.spatialDisabled = true;
      turret.cooldown = Number.POSITIVE_INFINITY;
      const playerIndex = entry.boat?.crew?.[turret.seatIndex ?? index];
      const now = finite(world.time);
      if (announceInput && Number.isInteger(playerIndex) && inputAttack(world, playerIndex) && now - finite(turret.spatialDamageDeniedAt, -999) >= 1.2) {
        turret.spatialDamageDeniedAt = now;
        emit(world, "dual-turret-denied", `${moduleUserLabel(entry, modules[index].id)} повреждена и не может стрелять. Сначала отремонтируй её.`, [playerIndex], {sourcePlayer: playerIndex, boatId: entry.boat.id, moduleId: modules[index].id, turretId: turret.id});
      }
    } else if (turret.spatialDisabled) {
      turret.spatialDisabled = false;
      if (!Number.isFinite(Number(turret.cooldown))) turret.cooldown = Math.max(0, finite(turret.spatialCooldownBeforeDisable));
      delete turret.spatialCooldownBeforeDisable;
    }
  }
}

export function syncLegacyVesselDamageEffects(context = {}, announceInput = false) {
  const world = context?.world;
  if (!world) return;
  for (const entry of context?.nativeVessels || []) syncLegacyMountedWeapons(world, entry, announceInput);
}

function recognizedEvent(event) {
  return ["enemy-bullet-boat-hit", "heavy-bullet-boat-hit", "enemy-ram-hit", "heavy-ram-hit", "elite-ram-impact"].includes(event?.type);
}

export function reconcileHostileVesselSpatialDamage(context = {}) {
  const world = context.world;
  if (!world) return;
  const entries = new Map((context.nativeVessels || []).map(entry => [String(entry?.boat?.id), entry]));
  for (const event of freshEvents(world, context.eventStart || 0, "world-step")) {
    if (!recognizedEvent(event) || event.targetBoat == null) continue;
    const entry = entries.get(String(event.targetBoat));
    if (!entry?.definition?.capabilities?.zonalDamage || entry.definition?.damage?.mode !== "zonal") continue;
    const profile = legacyProfile(world, event);
    if (!profile) continue;
    undoLegacyBoatDamage(entry, profile);
    const result = applySpatialVesselImpact(world, entry, {
      kind: profile.kind,
      damage: profile.damage,
      playerDamage: profile.playerDamage,
      sourcePoint: profile.source,
      impactPoint: {x: finite(event.x, entry.boat.x), y: finite(event.y, entry.boat.y)},
      sourceId: event.sourcePursuerId || event.gunnerId || null,
      projectileId: event.projectileId || `${event.type}:${world.time}:${event.targetBoat}`,
      weapon: profile.kind === "heavy-bullet" ? "heavy-automatic" : profile.kind === "ram" ? "ram" : "automatic",
      impactHeight: profile.kind === "ram" ? 0.7 : undefined,
      preferTargetDeck: false,
      announceHealth: true,
    });
    attachImpact(event, result);
  }
}

function restoreKilledOccupant(world, entry, playerIndex, snapshot, scope = "world-step") {
  const player = world?.players?.[playerIndex];
  if (!player || !snapshot?.alive) return false;
  player.mode = snapshot.mode;
  player.activeBoat = snapshot.activeBoat;
  player.vesselDeckInputOwned = snapshot.vesselDeckInputOwned;
  player.x = snapshot.x;
  player.y = snapshot.y;
  player.heading = snapshot.heading;
  Object.assign(player.combat, {alive: true, respawnRemaining: snapshot.respawnRemaining, knockedDown: snapshot.knockedDown, knockdownRemaining: snapshot.knockdownRemaining, pendingDamage: snapshot.pendingDamage, carriedCrate: snapshot.carriedCrate || null});
  const spatialSnapshot = snapshotFor(world, scope);
  const boatBefore = spatialSnapshot?.boats?.get(String(entry.boat.id));
  if (boatBefore) {
    const seat = boatBefore.crew.findIndex(value => value === playerIndex);
    if (seat >= 0) { entry.boat.crew ||= []; entry.boat.crew[seat] = playerIndex; }
    if (boatBefore.driver === playerIndex) { entry.boat.driver = playerIndex; entry.boat.throttle = boatBefore.throttle; entry.boat.rudder = boatBefore.rudder; }
  }
  const local = boatBefore?.occupants?.[playerIndex];
  if (local) { try { setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, local); } catch (_) {} }
  if (snapshot.carriedCrate) {
    const crate = values(world?.freeActivities?.crates).find(item => String(item?.id) === String(snapshot.carriedCrate));
    const crateBefore = spatialSnapshot?.crates?.get(String(snapshot.carriedCrate));
    if (crate && crateBefore) Object.assign(crate, crateBefore);
  }
  return true;
}

function correctHealthAnnouncement(world, playerIndex, legacyDamage, correctDamage, weapon) {
  const player = world?.players?.[playerIndex];
  if (!player?.combat) return;
  for (let index = world.events.length - 1; index >= 0; index -= 1) {
    const event = world.events[index];
    if (!event || event.type !== "combat-health" || Number(event.targetPlayer) !== playerIndex) continue;
    if (weapon && event.weapon && String(event.weapon) !== String(weapon)) continue;
    if (Math.abs(finite(event.damage) - finite(legacyDamage)) > Math.max(0.2, finite(legacyDamage) * 0.08)) continue;
    if (correctDamage <= 1) world.events.splice(index, 1);
    else { event.damage = correctDamage; event.health = player.combat.health; event.text = `Здоровье ${Math.round(player.combat.health)}.`; event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION; }
    return;
  }
}

export function compensateLegacyPlayerDamage(world, entry, playerIndex, legacyDamage, correctDamage, details = {}, scope = "world-step") {
  const player = world?.players?.[playerIndex];
  const before = snapshotFor(world, scope)?.players?.[playerIndex];
  if (!player?.combat || !before) return;
  const legacy = Math.max(0, finite(legacyDamage));
  const correct = Math.max(0, finite(correctDamage));
  const difference = correct - legacy;
  if (player.combat.alive && difference > 0.05) {
    applyCombatDamage(world, playerIndex, difference, -1, {weapon: details.weapon || "vessel-spatial-impact", heavy: Boolean(details.heavy), eventType: "vessel-spatial-adjustment", sourcePoint: details.sourcePoint || null, announceHealth: false}, {dropCarriedCrate});
  } else if (player.combat.alive && difference < -0.05) {
    const refund = -difference;
    player.combat.health = clamp(finite(player.combat.health) + refund, 0, before.health);
    player.combat.stun = Math.max(0, finite(player.combat.stun) - refund * (details.heavy ? 1.8 : 0.92));
    if (correct <= 0.35 && !before.knockedDown) { player.combat.knockedDown = false; player.combat.knockdownRemaining = before.knockdownRemaining; }
  } else if (!player.combat.alive) {
    const correctedHealth = before.health - correct;
    if (correctedHealth > 0 && restoreKilledOccupant(world, entry, playerIndex, before, scope)) {
      player.combat.health = clamp(correctedHealth, 0, 100);
      player.combat.stun = Math.min(before.stun + correct * (details.heavy ? 1.8 : 0.92), 100);
      for (let index = world.events.length - 1; index >= 0; index -= 1) {
        const event = world.events[index];
        if (!event) continue;
        const belongsToPlayer = Number(event.targetPlayer) === playerIndex || (event.type === "cargo-drop" && Number(event.sourcePlayer) === playerIndex);
        if (!belongsToPlayer) continue;
        if (["player-death", "player-defeated", "cargo-drop"].includes(event.type)) world.events.splice(index, 1);
      }
    }
  }
  correctHealthAnnouncement(world, playerIndex, legacy, correct, details.weapon);
}

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
    const result = applySpatialVesselImpact(world, entry, {kind: "heavy-bullet", damage: Math.max(8, legacyHull / Math.max(0.1, finite(entry.definition?.damage?.hullShare, 0.25))), playerDamage: 7.2, sourcePoint: source, impactPoint: {x: finite(first.x, entry.boat.x), y: finite(first.y, entry.boat.y)}, projectileId: first.projectileId, sourceId: first.turretId, weapon: "elite-automatic", preferTargetDeck: false, damagePlayers: false});
    attachImpact(first, result);
    for (const event of group) {
      const local = entry.instance?.occupants?.[event.targetPlayer] || snapshotFor(world, "world-step")?.boats?.get(String(entry.boat.id))?.occupants?.[event.targetPlayer];
      const correctScale = local && result ? occupantDamageScale(entry, local, values(entry.definition.decks).find(deck => deck.id === result.deckId), result.localImpact, {kind: "heavy-bullet"}, result.transmission) : 0;
      const correctDamage = 7.2 * correctScale;
      const legacyDamage = finite(event.humanDamage, 7.2);
      compensateLegacyPlayerDamage(world, entry, Number(event.targetPlayer), legacyDamage, correctDamage, {weapon: "elite-automatic", heavy: true, sourcePoint: source});
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
