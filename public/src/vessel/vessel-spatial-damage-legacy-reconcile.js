"use strict";

import {dropCarriedCrate} from "../free-roam-activities.js?v=44";
import {applyCombatDamage} from "../free-roam-combat-v2.js?v=6";
import {setVesselOccupantPosition} from "./vessel-interior.js";
import {VESSEL_SPATIAL_DAMAGE_VERSION, applySpatialVesselImpact, clamp, finite, freshEvents, snapshotFor, values} from "./vessel-spatial-damage-core.js?v=1";
import {attachImpact, legacyProfile, undoLegacyBoatDamage} from "./vessel-spatial-damage-legacy-profiles.js?v=1";

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
  Object.assign(player.combat, {
    alive: true,
    respawnRemaining: snapshot.respawnRemaining,
    knockedDown: snapshot.knockedDown,
    knockdownRemaining: snapshot.knockdownRemaining,
    pendingDamage: snapshot.pendingDamage,
    carriedCrate: snapshot.carriedCrate || null,
  });
  const spatialSnapshot = snapshotFor(world, scope);
  const boatBefore = spatialSnapshot?.boats?.get(String(entry.boat.id));
  if (boatBefore) {
    const seat = boatBefore.crew.findIndex(value => value === playerIndex);
    if (seat >= 0) {
      entry.boat.crew ||= [];
      entry.boat.crew[seat] = playerIndex;
    }
    if (boatBefore.driver === playerIndex) {
      entry.boat.driver = playerIndex;
      entry.boat.throttle = boatBefore.throttle;
      entry.boat.rudder = boatBefore.rudder;
    }
  }
  const local = boatBefore?.occupants?.[playerIndex];
  if (local) {
    try { setVesselOccupantPosition(entry.definition, entry.instance, playerIndex, local); } catch (_) {}
  }
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
    if (correctDamage <= 1) {
      world.events.splice(index, 1);
    } else {
      event.damage = correctDamage;
      event.health = player.combat.health;
      event.text = `Здоровье ${Math.round(player.combat.health)}.`;
      event.vesselSpatialDamageVersion = VESSEL_SPATIAL_DAMAGE_VERSION;
    }
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
    applyCombatDamage(world, playerIndex, difference, -1, {
      weapon: details.weapon || "vessel-spatial-impact",
      heavy: Boolean(details.heavy),
      eventType: "vessel-spatial-adjustment",
      sourcePoint: details.sourcePoint || null,
      announceHealth: false,
    }, {dropCarriedCrate});
  } else if (player.combat.alive && difference < -0.05) {
    const refund = -difference;
    player.combat.health = clamp(finite(player.combat.health) + refund, 0, before.health);
    player.combat.stun = Math.max(0, finite(player.combat.stun) - refund * (details.heavy ? 1.8 : 0.92));
    if (correct <= 0.35 && !before.knockedDown) {
      player.combat.knockedDown = false;
      player.combat.knockdownRemaining = before.knockdownRemaining;
    }
  } else if (!player.combat.alive) {
    const correctedHealth = before.health - correct;
    if (correctedHealth > 0 && restoreKilledOccupant(world, entry, playerIndex, before, scope)) {
      player.combat.health = clamp(correctedHealth, 0, 100);
      player.combat.stun = Math.min(before.stun + correct * (details.heavy ? 1.8 : 0.92), 100);
      for (let index = world.events.length - 1; index >= 0; index -= 1) {
        const event = world.events[index];
        if (!event) continue;
        const belongsToPlayer = Number(event.targetPlayer) === playerIndex
          || (event.type === "cargo-drop" && Number(event.sourcePlayer) === playerIndex);
        if (!belongsToPlayer) continue;
        if (["player-death", "player-defeated", "cargo-drop"].includes(event.type)) world.events.splice(index, 1);
      }
    }
  }
  correctHealthAnnouncement(world, playerIndex, legacy, correct, details.weapon);
}
