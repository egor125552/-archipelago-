"use strict";

import {adjustVesselZoneWater, vesselOccupantWaterState} from "../vessel-deck-runtime.js";
import {capturedVesselSharedInput} from "./vessel-deck-input-bridge-system.js?v=2";
import {stationOwnsInput, vesselOwnsSubsystem} from "../vessel-authority.js?v=1";
import {applyCombatDamage} from "../../free-roam-combat-v2.js?v=6";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const legacyMasks = new WeakMap();
const BASE_PUMP_RATE = 7.5;
const LEGACY_LEAK_TO_WATER = 0.33;
const EMERGENCY_SECONDS = 45;

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 280) world.events.splice(0, world.events.length - 280);
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
  instance.interior.waterBridge ||= {};
  const meta = instance.interior.waterBridge;
  meta.announcedBucket ||= {};
  meta.floodDisabledModules ||= {};
  meta.damageAccumulator ||= {};
  if (!Number.isInteger(meta.damageCursor)) meta.damageCursor = 0;
  return meta;
}

function flooding(entry, zoneId) {
  return clamp(entry?.instance?.zones?.[zoneId]?.flooding, 0, 100);
}

function aggregate(entry, zones) {
  if (!zones.length) return 0;
  return zones.reduce((sum, item) => sum + flooding(entry, item.zone.id), 0) / zones.length;
}

function zoneLeak(entry, zoneId) {
  return clamp(entry?.instance?.zones?.[zoneId]?.leakRate, 0, 16);
}

function setZoneLeak(entry, zoneId, value) {
  entry.instance.zones ||= {};
  entry.instance.zones[zoneId] ||= {health: 100, flooding: 0, fire: 0};
  entry.instance.zones[zoneId].leakRate = clamp(value, 0, 16);
  return entry.instance.zones[zoneId].leakRate;
}

function totalLeak(entry, zones) {
  return clamp(zones.reduce((sum, item) => sum + zoneLeak(entry, item.zone.id), 0), 0, 16);
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

function migrationOrder(entry, zones) {
  return [...zones].sort((left, right) => {
    const leftHealth = clamp(entry.instance?.zones?.[left.zone.id]?.health ?? 100, 0, 100);
    const rightHealth = clamp(entry.instance?.zones?.[right.zone.id]?.health ?? 100, 0, 100);
    if (leftHealth !== rightHealth) return leftHealth - rightHealth;
    return (Number(right.config.leakWeight) || 0) - (Number(left.config.leakWeight) || 0);
  });
}

function migrateLegacyWater(entry, zones, meta) {
  if (meta.authorityVersion === 2) return;
  const legacyWater = clamp(entry.boat?.water, 0, 100);
  const legacyLeak = clamp(entry.boat?.leak, 0, 16);
  const values = zones.map(item => flooding(entry, item.zone.id));
  const allDry = values.every(value => value <= 0.001);
  const looksLikeOldBridge = values.length > 1
    && values.every(value => Math.abs(value - legacyWater) <= 0.75);

  if (legacyWater > 0 && (allDry || looksLikeOldBridge)) {
    for (const item of zones) adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, -flooding(entry, item.zone.id));
    let volume = legacyWater * zones.length;
    for (const item of migrationOrder(entry, zones)) {
      if (volume <= 0.001) break;
      const add = Math.min(100, volume);
      adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, add);
      volume -= add;
    }
  }

  if (zones.every(item => zoneLeak(entry, item.zone.id) <= 0.001) && legacyLeak > 0) {
    const first = migrationOrder(entry, zones)[0];
    if (first) setZoneLeak(entry, first.zone.id, legacyLeak);
  }

  meta.authorityVersion = 2;
  meta.initialized = true;
  meta.lastAggregate = aggregate(entry, zones);
}

function crewIndices(entry) {
  const result = new Set();
  for (const raw of Object.keys(entry.instance?.occupants || {})) {
    const playerIndex = Number(raw);
    if (Number.isInteger(playerIndex)) result.add(playerIndex);
  }
  for (const playerIndex of entry.boat?.crew || []) if (Number.isInteger(playerIndex)) result.add(playerIndex);
  if (Number.isInteger(entry.boat?.driver)) result.add(entry.boat.driver);
  return [...result];
}

function fieldValue(world, playerIndex, field) {
  const captured = capturedVesselSharedInput(world, playerIndex);
  if (captured && Object.prototype.hasOwnProperty.call(captured, field)) return Boolean(captured[field]);
  return Boolean(
    world?.freeActivities?.inputs?.[playerIndex]?.[field]
    || world?.operationInputs?.[playerIndex]?.[field]
    || world?.inputs?.[playerIndex]?.[field]
  );
}

function inputStores(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function suppressLegacyInputs(world, playerIndices) {
  const snapshots = [];
  for (const playerIndex of playerIndices) {
    for (const store of inputStores(world, playerIndex)) {
      snapshots.push([store, "pump", store.pump], [store, "repair", store.repair]);
      store.pump = false;
      store.repair = false;
    }
  }
  return snapshots;
}

function restoreInputs(snapshots) {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const [store, field, value] = snapshots[index];
    store[field] = value;
  }
}

function moduleDefinition(entry, moduleId) {
  return (entry?.definition?.modules || []).find(module => module.id === moduleId) || null;
}

function engineUnavailable(entry, meta) {
  const engine = entry.instance?.modules?.engine;
  if (!engine) return false;
  return (Number(engine.health) || 0) <= 0 || engine.enabled === false || Boolean(meta.floodDisabledModules.engine);
}

function beginAuthorityMask({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const byBoat = new Map();
  legacyMasks.set(world, byBoat);

  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;
    const zones = waterZones(entry);
    if (!zones.length) continue;
    const meta = waterMeta(entry.instance);
    migrateLegacyWater(entry, zones, meta);
    const players = crewIndices(entry);
    const pumpRequested = players.some(index => fieldValue(world, index, "pump"));
    const hullRepairRequested = players.some(index => fieldValue(world, index, "repair") && !stationOwnsInput(entry, index, "repair"));
    const snapshots = suppressLegacyInputs(world, players);
    const originalHull = Math.max(0, Number(entry.boat.hull) || 0);
    const moduleStalled = engineUnavailable(entry, meta);
    const legacyStallRequired = (Number(entry.boat.fuel) || 0) <= 0.01 || (Number(entry.boat.engineTemp) || 0) >= 104;

    const record = {
      entry,
      zones,
      meta,
      eventStart,
      snapshots,
      pumpRequested,
      hullRepairRequested,
      water: clamp(entry.boat.water, 0, 100),
      leak: clamp(entry.boat.leak, 0, 16),
      pumpActive: Boolean(entry.boat.pumpActive),
      hull: originalHull,
      hullMask: Math.max(0.05, originalHull),
      emergencyActive: Boolean(entry.boat.emergencyActive),
      emergencyRemaining: Number(entry.boat.emergencyRemaining) || 0,
      emergencyWarned15: Boolean(entry.boat.emergencyWarned15),
      emergencyWarned5: Boolean(entry.boat.emergencyWarned5),
      restartProgress: Number(entry.boat.restartProgress) || 0,
      hullRepairProgress: Number(entry.boat.hullRepairProgress) || 0,
      repairQuarter: Number(entry.boat.repairQuarter) || 0,
      engineStalled: Boolean(entry.boat.engineStalled),
      moduleStalled,
    };
    byBoat.set(entry.boat.id, record);

    entry.boat.water = 0;
    entry.boat.leak = 0;
    entry.boat.pumpActive = false;
    entry.boat.emergencyActive = false;
    entry.boat.emergencyRemaining = 0;
    entry.boat.restartProgress = 0;
    entry.boat.hullRepairProgress = 0;
    entry.boat.repairQuarter = 0;
    entry.boat.hull = record.hullMask;

    if (moduleStalled && !legacyStallRequired) {
      entry.boat.engineStalled = false;
      entry.boat.throttle = 0;
      const driver = entry.boat.driver;
      if (Number.isInteger(driver)) {
        for (const store of inputStores(world, driver)) {
          record.snapshots.push([store, "up", store.up], [store, "down", store.down]);
          store.up = false;
          store.down = false;
        }
      }
    }
  }
}

function incomingSide(boat, sourcePoint) {
  const absolute = Math.atan2(
    (Number(sourcePoint?.x) || 0) - (Number(boat?.x) || 0),
    -((Number(sourcePoint?.y) || 0) - (Number(boat?.y) || 0)),
  ) * 180 / Math.PI;
  const relative = Math.abs(((absolute - (Number(boat?.heading) || 0) + 180) % 360 + 360) % 360 - 180);
  if (relative <= 60) return "front";
  if (relative >= 120) return "rear";
  return "side";
}

function impactZone(record, world) {
  const {entry, zones, eventStart} = record;
  const events = (world.events || []).slice(eventStart).filter(event => event?.targetBoat === entry.boat.id);
  const last = events.at(-1);
  if (Number.isInteger(last?.sourcePlayer)) {
    const source = world.players?.[last.sourcePlayer];
    const side = incomingSide(entry.boat, source);
    const configured = entry.definition?.damage?.directionalZones?.[side];
    if (configured && zones.some(item => item.zone.id === configured)) return configured;
  }
  return migrationOrder(entry, zones)[0]?.zone.id || zones[0]?.zone.id || null;
}

function moduleForZone(entry, zoneId, meta) {
  const choices = entry.definition?.damage?.zoneModuleChoices?.[zoneId];
  if (Array.isArray(choices) && choices.length) {
    const valid = choices.filter(id => entry.instance?.modules?.[id]);
    if (valid.length) {
      const selected = valid[meta.damageCursor % valid.length];
      meta.damageCursor += 1;
      return selected;
    }
  }
  const configured = entry.definition?.damage?.zoneModules?.[zoneId];
  return configured && entry.instance?.modules?.[configured] ? configured : null;
}

function translateLegacyDamage(record, world, legacyHull, generatedLeak) {
  const {entry, zones, meta} = record;
  const hullDamage = Math.max(0, record.hullMask - legacyHull);
  if (hullDamage <= 0.001 && generatedLeak <= 0.001) return;
  const zoneId = impactZone(record, world);
  if (!zoneId) return;
  const zone = entry.instance.zones?.[zoneId];
  if (!zone) return;

  const hullShare = clamp(entry.definition?.damage?.hullShare ?? 0.55, 0.05, 1);
  const translatedDamage = hullDamage / hullShare;
  if (translatedDamage > 0) {
    zone.health = clamp((Number(zone.health) || 100) - translatedDamage, 0, 100);
    const moduleId = moduleForZone(entry, zoneId, meta);
    if (moduleId) {
      const module = entry.instance.modules[moduleId];
      module.health = clamp((Number(module.health) || 100) - translatedDamage * 0.72, 0, 100);
      if (module.health <= 0) module.enabled = false;
    }
    const hits = (world.events || []).slice(record.eventStart).filter(event => event?.targetBoat === entry.boat.id && event?.type === "gun-boat-hit").length;
    if (hits > 0) adjustVesselZoneWater(entry.definition, entry.instance, zoneId, hits * Math.max(0, Number(entry.definition?.damage?.floodingPerHit) || 0));
  }
  if (generatedLeak > 0) setZoneLeak(entry, zoneId, zoneLeak(entry, zoneId) + generatedLeak);
}

function runHullRepair(world, record, dt) {
  const {entry, zones} = record;
  const boat = entry.boat;
  const wettestLeak = [...zones].sort((a, b) => zoneLeak(entry, b.zone.id) - zoneLeak(entry, a.zone.id))[0] || null;
  const maximumHull = Math.max(1, Number(boat.hullMax) || 100);
  const needsRepair = (Number(boat.hull) || 0) < maximumHull - 0.5 || (wettestLeak && zoneLeak(entry, wettestLeak.zone.id) > 0.05);
  if (!record.hullRepairRequested || !needsRepair || boat.sunk) {
    boat.hullRepairProgress = 0;
    boat.repairQuarter = 0;
    return;
  }
  if ((Number(boat.repairPatches) || 0) <= 0) {
    const now = Number(world.time) || 0;
    if (now - (Number(record.meta.lastHullRepairDeniedAt) || -999) >= 1.3) {
      record.meta.lastHullRepairDeniedAt = now;
      emit(world, "repair-blocked", "Ремонтные пластины закончились.", crewIndices(entry));
    }
    boat.hullRepairProgress = 0;
    return;
  }
  const towed = world.tow?.towedBoat === boat.id;
  if (Math.abs(Number(boat.speed) || 0) > 1.8 && !towed) {
    boat.hullRepairProgress = Math.max(0, (Number(boat.hullRepairProgress) || 0) - dt * 0.7);
    return;
  }

  boat.hullRepairProgress = (Number(boat.hullRepairProgress) || 0) + dt;
  const duration = 3.1;
  const quarter = Math.min(4, Math.floor(boat.hullRepairProgress / duration * 4));
  if (quarter > (Number(boat.repairQuarter) || 0) && quarter < 4) {
    boat.repairQuarter = quarter;
    emit(world, "hull-repair-progress", `Заделка пробоины: ${quarter * 25} процентов.`, crewIndices(entry), {percent: quarter * 25, boatId: boat.id});
  }
  if (boat.hullRepairProgress < duration) return;

  boat.hull = clamp((Number(boat.hull) || 0) + 22, 0, maximumHull);
  if (wettestLeak) setZoneLeak(entry, wettestLeak.zone.id, zoneLeak(entry, wettestLeak.zone.id) - 3.2);
  boat.repairPatches = Math.max(0, Math.floor(Number(boat.repairPatches) || 0) - 1);
  boat.hullRepairProgress = 0;
  boat.repairQuarter = 0;
  emit(world, "hull-repair-complete", `Пластина закреплена. Корпус ${Math.round(boat.hull)} из ${Math.round(maximumHull)}. Пластин осталось ${boat.repairPatches}.`, crewIndices(entry), {boatId: boat.id});
}

function updateLeaksAndPump(world, record, dt) {
  const {entry, zones} = record;
  for (const item of zones) {
    const leak = zoneLeak(entry, item.zone.id);
    if (leak > 0) adjustVesselZoneWater(entry.definition, entry.instance, item.zone.id, leak * dt * LEGACY_LEAK_TO_WATER);
  }

  const pump = entry.instance?.modules?.["bilge-pump"];
  const health = clamp(pump?.health ?? 100, 0, 100);
  const available = Boolean(pump && pump.enabled !== false && health > 0);
  if (pump) pump.active = Boolean(record.pumpRequested && available && !entry.boat.sunk);
  entry.boat.pumpActive = Boolean(pump?.active);

  if (record.pumpRequested && !available) {
    const now = Number(world.time) || 0;
    if (now - (Number(record.meta.lastPumpDeniedAt) || -999) >= 1.4) {
      record.meta.lastPumpDeniedAt = now;
      emit(world, "vessel-pump-disabled", "Трюмная помпа повреждена. Спустись в машинное отделение и отремонтируй её.", crewIndices(entry), {boatId: entry.boat.id, moduleId: "bilge-pump"});
    }
  }
  if (pump?.active) {
    const effectiveness = clamp(health / 100, 0.15, 1);
    removeFlooding(entry, zones, BASE_PUMP_RATE * effectiveness * dt);
  }
}

function updateFloodDisabledModules(entry, zones, meta) {
  const floodDisabled = meta.floodDisabledModules;
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
    }
  }

  for (const [moduleId, state] of Object.entries(entry.instance?.modules || {})) {
    if ((Number(state.health) || 0) <= 0) state.enabled = false;
    if (moduleDefinition(entry, moduleId)?.type === "pump" && state.enabled === false) state.active = false;
  }
}

function updateEngineState(world, record, dt) {
  const {entry, meta} = record;
  const boat = entry.boat;
  const engine = entry.instance?.modules?.engine;
  const floodBlocked = Boolean(meta.floodDisabledModules.engine);
  const damaged = engine && ((Number(engine.health) || 0) <= 0 || engine.enabled === false) && !floodBlocked;
  const legacyBlocked = (Number(boat.fuel) || 0) <= 0.01 || (Number(boat.engineTemp) || 0) >= 104;
  const mustStop = floodBlocked || damaged || legacyBlocked || boat.emergencyActive || boat.sunk;

  if (mustStop) {
    boat.engineStalled = true;
    boat.throttle = 0;
    boat.restartProgress = 0;
    if (floodBlocked) meta.floodStalled = true;
    return;
  }

  if (meta.floodStalled || boat.engineStalled) {
    boat.restartProgress = (Number(boat.restartProgress) || 0) + dt;
    if (boat.restartProgress < 1.2) {
      boat.engineStalled = true;
      return;
    }
    boat.restartProgress = 0;
    boat.engineStalled = false;
    meta.floodStalled = false;
    if (engine && (Number(engine.health) || 0) > 0) engine.enabled = true;
    emit(world, "engine-water-restart", "Главный двигатель снова запущен.", crewIndices(entry), {boatId: boat.id});
    return;
  }
  boat.engineStalled = false;
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
    emit(world, "vessel-zone-flooding", text, targets, {boatId: entry.boat.id, zoneId: item.zone.id, flooding: amount, threshold: bucket});
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

function releaseSunkOccupants(world, entry) {
  const targets = [];
  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    if (!player || player.activeBoat !== entry.boat.id) continue;
    targets.push(playerIndex);
    player.mode = "swim";
    player.activeBoat = null;
    player.vesselDeckInputOwned = false;
    player.running = false;
    player.x = Number(entry.boat.x) || 0;
    player.y = Number(entry.boat.y) || 0;
    player.heading = Number(entry.boat.heading) || 0;
  }
  entry.instance.occupants = {};
  if (entry.instance.interior) {
    entry.instance.interior.claims = {};
    entry.instance.interior.traversals = {};
  }
  entry.boat.driver = null;
  if (Array.isArray(entry.boat.crew)) entry.boat.crew.fill(null);
  if (targets.length) emit(world, "sink", "Корабль окончательно затонул. Ты оказался в воде.", targets, {boatId: entry.boat.id, x: entry.boat.x, y: entry.boat.y});
}

function updateEmergency(world, record, dt) {
  const {entry, zones} = record;
  const boat = entry.boat;
  const allFlooded = zones.length > 0 && zones.every(item => flooding(entry, item.zone.id) >= 99.5);
  const critical = (Number(boat.hull) || 0) <= 0 || allFlooded;

  if (critical && !boat.emergencyActive && !boat.sunk) {
    boat.emergencyActive = true;
    boat.emergencyRemaining = EMERGENCY_SECONDS;
    boat.emergencyWarned15 = false;
    boat.emergencyWarned5 = false;
    boat.engineStalled = true;
    boat.throttle = 0;
    emit(world, "flood-emergency-start", `Авария. Есть ${EMERGENCY_SECONDS} секунд: останови течь, откачай воду и восстанови повреждённые модули.`, crewIndices(entry), {boatId: boat.id, cause: allFlooded ? "flooded" : "wrecked"});
  }
  if (!boat.emergencyActive || boat.sunk) return;

  const recovered = aggregate(entry, zones) <= 35 && (Number(boat.hull) || 0) >= 5;
  if (recovered) {
    boat.emergencyActive = false;
    boat.emergencyRemaining = 0;
    boat.emergencyWarned15 = false;
    boat.emergencyWarned5 = false;
    emit(world, "flood-emergency-recovered", "Корабль стабилизирован. Осуши машинное отделение и восстанови модули, если они повреждены.", crewIndices(entry), {boatId: boat.id});
    return;
  }

  boat.emergencyRemaining = Math.max(0, Number(boat.emergencyRemaining) - dt);
  if (boat.emergencyRemaining <= 0) {
    boat.sunk = true;
    boat.emergencyActive = false;
    boat.speed = 0;
    boat.throttle = 0;
    boat.rudder = 0;
    boat.engineStalled = true;
    emit(world, "flood-emergency-failed", "Аварийное время вышло. Корабль потерян.", crewIndices(entry), {boatId: boat.id});
    releaseSunkOccupants(world, entry);
    return;
  }
  if (boat.emergencyRemaining <= 5 && !boat.emergencyWarned5) {
    boat.emergencyWarned5 = true;
    emit(world, "flood-emergency-warning", "Пять секунд до потери корабля.", crewIndices(entry), {boatId: boat.id, critical: true});
  } else if (boat.emergencyRemaining <= 15 && !boat.emergencyWarned15) {
    boat.emergencyWarned15 = true;
    emit(world, "flood-emergency-warning", "Пятнадцать секунд аварийного времени.", crewIndices(entry), {boatId: boat.id, critical: false});
  }
}

function finishAuthorityWater({world, nativeVessels, dt} = {}) {
  if (!world) return;
  const elapsed = clamp(dt, 0, 0.1);
  const byBoat = legacyMasks.get(world) || new Map();

  for (const entry of nativeVessels || []) {
    if (!entry?.boat || !vesselOwnsSubsystem(entry.definition, "flooding")) continue;
    const record = byBoat.get(entry.boat.id);
    if (!record) continue;
    const legacyHull = Math.max(0, Number(entry.boat.hull) || 0);
    const generatedLeak = clamp(entry.boat.leak, 0, 16);
    const legacyEngineStalled = Boolean(entry.boat.engineStalled);
    restoreInputs(record.snapshots);

    entry.boat.hull = record.hull <= 0 ? 0 : legacyHull;
    entry.boat.water = record.water;
    entry.boat.leak = record.leak;
    entry.boat.pumpActive = record.pumpActive;
    entry.boat.emergencyActive = record.emergencyActive;
    entry.boat.emergencyRemaining = record.emergencyRemaining;
    entry.boat.emergencyWarned15 = record.emergencyWarned15;
    entry.boat.emergencyWarned5 = record.emergencyWarned5;
    entry.boat.restartProgress = record.restartProgress;
    entry.boat.hullRepairProgress = record.hullRepairProgress;
    entry.boat.repairQuarter = record.repairQuarter;
    entry.boat.engineStalled = record.engineStalled || legacyEngineStalled;

    translateLegacyDamage(record, world, legacyHull, generatedLeak);
    runHullRepair(world, record, elapsed);
    updateLeaksAndPump(world, record, elapsed);
    updateFloodDisabledModules(entry, record.zones, record.meta);
    updateEmergency(world, record, elapsed);
    updateEngineState(world, record, elapsed);

    entry.boat.water = aggregate(entry, record.zones);
    entry.boat.leak = totalLeak(entry, record.zones);
    record.meta.lastAggregate = entry.boat.water;
    announceWater(world, entry, record.zones, record.meta);
    damageFloodedOccupants(world, entry, elapsed, record.meta);
  }

  legacyMasks.delete(world);
}

export const VESSEL_ZONE_WATER_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-zone-water-authority-before-step-v2",
    phase: "before-step",
    order: 50,
    run: beginAuthorityMask,
  }),
  Object.freeze({
    id: "vessel-zone-water-authority-after-step-v2",
    phase: "after-step",
    order: 12,
    run: finishAuthorityWater,
  }),
]);
