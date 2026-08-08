"use strict";

import {adjustVesselZoneWater, vesselOccupantWaterState} from "../vessel-deck-runtime.js";
import {applyCombatDamage} from "../../free-roam-combat-v2.js?v=6";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function zoneConfig(definition, deck, zone) {
  return definition?.deckArchitecture?.entities?.get?.(`zone:${deck.id}:${zone.id}`)?.water || zone.water || null;
}

function waterZones(entry) {
  const result = [];
  for (const deck of entry?.definition?.decks || []) {
    for (const zone of deck.zones || []) {
      const config = zoneConfig(entry.definition, deck, zone);
      if (config?.enabled) result.push({deck, zone, config});
    }
  }
  return result;
}

function waterMeta(instance) {
  instance.interior ||= {};
  instance.interior.waterBridge ||= {
    initialized: false,
    lastAggregate: 0,
    announcedBucket: {},
    floodDisabledModules: {},
    floodStalled: false,
    damageAccumulator: {},
  };
  const meta = instance.interior.waterBridge;
  meta.announcedBucket ||= {};
  meta.floodDisabledModules ||= {};
  meta.damageAccumulator ||= {};
  return meta;
}

function flooding(entry, zoneId) {
  return clamp(entry?.instance?.zones?.[zoneId]?.flooding, 0, 100);
}

function aggregate(entry, zones) {
  if (!zones.length) return 0;
  return zones.reduce((sum, item) => sum + flooding(entry, item.zone.id), 0) / zones.length;
}

function addFlooding(entry, zones, totalDelta) {
  let remaining = Math.max(0, Number(totalDelta) || 0);
  if (!remaining || !zones.length) return;
  const positiveWeight = zones.reduce((sum, item) => sum + Math.max(0, Number(item.config.leakWeight) || 0), 0);
  const weighted = positiveWeight > 0
    ? zones.map(item => ({...item, weight: Math.max(0, Number(item.config.leakWeight) || 0) / positiveWeight}))
    : zones.map(item => ({...item, weight: 1 / zones.length}));

  for (let pass = 0; pass < 3 && remaining > 0.001; pass += 1) {
    const available = weighted.filter(item => flooding(entry, item.zone.id) < 99.999);
    if (!available.length) break;
    const availableWeight = available.reduce((sum, item) => sum + item.weight, 0) || available.length;
    let applied = 0;
    for (const item of available) {
      const before = flooding(entry, item.zone.id);
      const share = item.weight > 0 ? item.weight / availableWeight : 1 / available.length;
      const requested = remaining * share;
      const after = adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, requested);
      applied += Math.max(0, after - before);
    }
    if (applied <= 0.001) break;
    remaining = Math.max(0, remaining - applied);
  }
}

function removeFlooding(entry, zones, totalDelta) {
  let remaining = Math.max(0, Number(totalDelta) || 0);
  if (!remaining || !zones.length) return;
  const ordered = [...zones].sort((left, right) => flooding(entry, right.zone.id) - flooding(entry, left.zone.id));
  for (const item of ordered) {
    if (remaining <= 0.001) break;
    const before = flooding(entry, item.zone.id);
    const take = Math.min(before, remaining);
    const after = adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, -take);
    remaining -= Math.max(0, before - after);
  }
}

function initialHydration(entry, zones, legacyWater) {
  if (legacyWater <= 0 || zones.some(item => flooding(entry, item.zone.id) > 0.001)) return;
  for (const item of zones) adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, legacyWater);
}

function moduleDefinition(entry, moduleId) {
  return (entry?.definition?.modules || []).find(module => module.id === moduleId) || null;
}

function updateFloodDisabledModules(entry, zones, meta) {
  const floodDisabled = meta.floodDisabledModules;
  let propulsionFlooded = false;
  for (const item of zones) {
    const disableAt = clamp(item.config.disableAt ?? 90, 0, 100);
    const restoreAt = clamp(item.config.restoreAt ?? Math.min(55, disableAt - 10), 0, disableAt);
    const amount = flooding(entry, item.zone.id);
    for (const moduleId of item.config.disableModules || []) {
      const state = entry.instance?.modules?.[moduleId];
      if (!state) continue;
      if (amount >= disableAt) {
        floodDisabled[moduleId] = true;
        state.enabled = false;
      } else if (amount <= restoreAt && floodDisabled[moduleId]) {
        delete floodDisabled[moduleId];
        if ((Number(state.health) || 0) > 0) state.enabled = true;
      }
      if (floodDisabled[moduleId] && moduleDefinition(entry, moduleId)?.type === "propulsion") propulsionFlooded = true;
    }
  }

  if (propulsionFlooded) {
    entry.boat.engineStalled = true;
    meta.floodStalled = true;
  } else if (meta.floodStalled) {
    const disabledPropulsion = Object.keys(floodDisabled).some(moduleId => moduleDefinition(entry, moduleId)?.type === "propulsion");
    if (!disabledPropulsion) {
      meta.floodStalled = false;
      if (!entry.boat.sunk && (Number(entry.boat.fuel) || 0) > 0.01) entry.boat.engineStalled = false;
    }
  }
}

function bucketFor(value) {
  const amount = clamp(value, 0, 100);
  if (amount >= 99.5) return 100;
  if (amount >= 75) return 75;
  if (amount >= 50) return 50;
  if (amount >= 25) return 25;
  if (amount >= 10) return 10;
  return 0;
}

function zoneTargets(entry, zoneId, critical) {
  const occupants = Object.entries(entry.instance?.occupants || {})
    .filter(([, occupant]) => critical || occupant?.zoneId === zoneId)
    .map(([index]) => Number(index))
    .filter(Number.isInteger);
  return [...new Set(occupants)];
}

function announceWater(world, entry, zones, meta) {
  for (const item of zones) {
    const amount = flooding(entry, item.zone.id);
    const bucket = bucketFor(amount);
    const previous = meta.announcedBucket[item.zone.id];
    meta.announcedBucket[item.zone.id] = bucket;
    if (previous == null || previous === bucket) continue;
    const targets = zoneTargets(entry, item.zone.id, bucket >= 75 || previous >= 75);
    if (!targets.length) continue;
    const direction = bucket > previous ? "поднимается" : "снижается";
    const text = bucket >= 100
      ? `${item.zone.label}: отсек полностью затоплен.`
      : bucket === 0
        ? `${item.zone.label}: вода откачана.`
        : `${item.zone.label}: вода ${direction}, ${bucket} процентов.`;
    emit(world, "vessel-zone-flooding", text, targets, {
      boatId: entry.boat.id,
      zoneId: item.zone.id,
      flooding: amount,
      threshold: bucket,
    });
  }
}

function damageFloodedOccupants(world, entry, dt, meta) {
  for (const rawIndex of Object.keys(entry.instance?.occupants || {})) {
    const playerIndex = Number(rawIndex);
    const player = world.players?.[playerIndex];
    if (!Number.isInteger(playerIndex) || !player || player.activeBoat !== entry.boat.id || player.combat?.alive === false) continue;
    const state = vesselOccupantWaterState(entry.definition, entry.instance, playerIndex);
    if (state.damagePerSecond <= 0) {
      meta.damageAccumulator[rawIndex] = 0;
      continue;
    }
    meta.damageAccumulator[rawIndex] = (Number(meta.damageAccumulator[rawIndex]) || 0) + dt;
    if (meta.damageAccumulator[rawIndex] < 0.5) continue;
    const elapsed = meta.damageAccumulator[rawIndex];
    meta.damageAccumulator[rawIndex] = 0;
    applyCombatDamage(world, playerIndex, state.damagePerSecond * elapsed, null, {
      weapon: "flooding",
      heavy: false,
      eventType: "vessel-flooding-hit",
      sourcePoint: entry.boat,
    }, {});
  }
}

function bridgeLegacyWater(context) {
  const world = context?.world;
  const dt = clamp(context?.dt, 0, 0.1);
  if (!world) return;
  for (const entry of context.nativeVessels || []) {
    const zones = waterZones(entry);
    if (!zones.length || !entry.boat) continue;
    const meta = waterMeta(entry.instance);
    const legacyWater = clamp(entry.boat.water, 0, 100);
    if (!meta.initialized) {
      initialHydration(entry, zones, legacyWater);
      meta.lastAggregate = aggregate(entry, zones);
      meta.initialized = true;
    }

    const before = Number.isFinite(Number(meta.lastAggregate)) ? Number(meta.lastAggregate) : aggregate(entry, zones);
    const delta = legacyWater - before;
    const totalDelta = Math.abs(delta) * zones.length;
    if (delta > 0.001) addFlooding(entry, zones, totalDelta);
    else if (delta < -0.001) removeFlooding(entry, zones, totalDelta);

    updateFloodDisabledModules(entry, zones, meta);
    const next = aggregate(entry, zones);
    entry.boat.water = next;
    meta.lastAggregate = next;
    announceWater(world, entry, zones, meta);
    damageFloodedOccupants(world, entry, dt, meta);
  }
}

export const VESSEL_ZONE_WATER_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-zone-water-bridge-v1",
    phase: "after-step",
    order: 12,
    run: bridgeLegacyWater,
  }),
]);
