"use strict";

import {vesselOwnsSubsystem} from "../vessel-authority.js?v=1";
import {
  applyRoutedVesselBlast,
  applyRoutedVesselImpact,
  drainExternalVesselImpacts,
  vesselSupportsRoutedDamage,
} from "../vessel-impact-routing.js?v=1";

const legacyFrames = new WeakMap();
const stagedImpacts = new WeakMap();
const HIT_EVENT_TYPES = new Set(["gun-boat-hit", "enemy-bullet-boat-hit"]);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function zoneRecord(entry, zoneId) {
  for (const deck of entry?.definition?.decks || []) {
    for (const zone of deck.zones || []) if (zone.id === zoneId) return {deck, zone};
  }
  return null;
}

function zoneAccusative(entry, zoneId) {
  const record = zoneRecord(entry, zoneId);
  return record?.zone?.presentation?.forms?.accusative || record?.zone?.label || zoneId || "отсек";
}

function routedEntry(entry) {
  return vesselSupportsRoutedDamage(entry) && vesselOwnsSubsystem(entry.definition, "damage");
}

function snapshotLegacyFrame({world, nativeVessels, eventStart = 0} = {}) {
  if (!world) return;
  const byBoat = new Map();
  for (const entry of nativeVessels || []) {
    if (!routedEntry(entry)) continue;
    byBoat.set(entry.boat.id, {
      entry,
      eventStart,
      hull: Math.max(0, Number(entry.boat.hull) || 0),
      hullMax: Math.max(1, Number(entry.boat.hullMax) || 100),
      leak: Math.max(0, Number(entry.boat.leak) || 0),
      floodingAuthority: vesselOwnsSubsystem(entry.definition, "flooding"),
    });
  }
  legacyFrames.set(world, byBoat);
}

function nominalImpact(event) {
  if (event?.type === "gun-boat-hit") {
    if (event.weapon === "pistol") {
      return {hull: Math.max(0.01, Number(event.damage) || 2), leak: 0.06, weapon: "pistol"};
    }
    return {hull: Math.max(0.01, Number(event.damage) || 5), leak: 0.18, weapon: event.weapon || "automatic"};
  }
  if (event?.type === "enemy-bullet-boat-hit") {
    return {hull: Math.max(0.01, Number(event.damage) || 3), leak: Math.max(0.01, Number(event.leak) || 0.14), weapon: event.weapon || "enemy-bullet"};
  }
  return null;
}

function eventImpactPoint(event, boat) {
  if (Number.isFinite(Number(event?.impactX)) && Number.isFinite(Number(event?.impactY))) {
    return {x: Number(event.impactX), y: Number(event.impactY)};
  }
  if (Number.isFinite(Number(event?.x)) && Number.isFinite(Number(event?.y))) {
    return {x: Number(event.x), y: Number(event.y)};
  }
  return {x: Number(boat?.x) || 0, y: Number(boat?.y) || 0};
}

function eventSourcePoint(world, event) {
  if (Number.isFinite(Number(event?.sourceX)) && Number.isFinite(Number(event?.sourceY))) {
    return {x: Number(event.sourceX), y: Number(event.sourceY)};
  }
  if (Number.isInteger(event?.sourcePlayer)) {
    const source = world?.players?.[event.sourcePlayer];
    if (source) return {x: Number(source.x) || 0, y: Number(source.y) || 0};
  }
  return null;
}

function captureLegacyBulletImpacts({world} = {}) {
  if (!world) return;
  const frames = legacyFrames.get(world) || new Map();
  const staged = [];

  for (const record of frames.values()) {
    const {entry} = record;
    const events = (world.events || []).slice(record.eventStart)
      .filter(event => event?.targetBoat === entry.boat.id && HIT_EVENT_TYPES.has(event?.type));
    if (!events.length) continue;

    const nominal = events.map(event => ({event, ...nominalImpact(event)})).filter(item => item.hull > 0);
    if (!nominal.length) continue;
    const nominalHull = nominal.reduce((sum, item) => sum + item.hull, 0);
    const nominalLeak = nominal.reduce((sum, item) => sum + item.leak, 0);
    const actualHullLoss = Math.max(0, record.hull - (Number(entry.boat.hull) || 0));
    const generatedLeak = record.floodingAuthority
      ? Math.max(0, Number(entry.boat.leak) || 0)
      : Math.max(0, (Number(entry.boat.leak) || 0) - record.leak);
    const consumedHull = Math.min(actualHullLoss, nominalHull);
    const consumedLeak = Math.min(generatedLeak, nominalLeak);
    if (consumedHull <= 0.001 && consumedLeak <= 0.001) continue;

    const hullScale = nominalHull > 0 ? consumedHull / nominalHull : 0;
    const leakScale = nominalLeak > 0 ? consumedLeak / nominalLeak : 0;
    entry.boat.hull = Math.min(record.hull, (Number(entry.boat.hull) || 0) + consumedHull);
    entry.boat.leak = Math.max(0, (Number(entry.boat.leak) || 0) - consumedLeak);

    for (const item of nominal) {
      staged.push({
        entry,
        event: item.event,
        descriptor: {
          legacyHullDamage: item.hull * hullScale,
          leak: item.leak * leakScale,
          flooding: Math.max(0, Number(entry.definition?.damage?.floodingPerHit) || 0) * hullScale,
          sourcePoint: eventSourcePoint(world, item.event),
          impactPoint: eventImpactPoint(item.event, entry.boat),
          weapon: item.weapon,
        },
      });
    }
  }

  stagedImpacts.set(world, staged);
}

function decorateNotice(entry, event, result) {
  if (!event || !result?.zoneId) return;
  const accusative = zoneAccusative(entry, result.zoneId);
  const hull = Math.round(Number(entry.boat.hull) || 0);
  const hullMax = Math.round(Math.max(1, Number(entry.boat.hullMax) || 100));
  Object.assign(event, {
    vesselZonalImpact: true,
    zoneId: result.zoneId,
    zoneLabel: result.zoneLabel,
    deckId: result.deckId,
    moduleId: result.moduleId || null,
    hull: entry.boat.hull,
    hullMax: entry.boat.hullMax,
    impactX: result.worldImpact?.x,
    impactY: result.worldImpact?.y,
  });
  if (event.type === "enemy-bullet-boat-hit") {
    event.text = `Вражеская пуля попала в ${accusative}. Корпус ${hull} из ${hullMax}.`;
  } else if (event.type === "gun-boat-hit") {
    event.text = `Попадание в ${accusative}. Корпус ${hull} из ${hullMax}.`;
  }
}

function decoratePairedDamageNotice(world, entry, sourceEvent, result) {
  if (sourceEvent?.type !== "gun-boat-hit" || !result?.zoneId) return;
  const events = world.events || [];
  const start = Math.max(0, events.indexOf(sourceEvent));
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.targetBoat !== entry.boat.id) continue;
    if (event.type === "gun-boat-hit") break;
    if (event.type !== "gun-boat-damaged") continue;
    if (Number.isInteger(sourceEvent.sourcePlayer) && event.sourcePlayer !== sourceEvent.sourcePlayer) continue;
    decorateNotice(entry, event, result);
    event.text = `Попадание в ${zoneAccusative(entry, result.zoneId)}. Корпус ${Math.round(entry.boat.hull)} из ${Math.round(Math.max(1, Number(entry.boat.hullMax) || 100))}.`;
    break;
  }
}

function applyStagedBulletImpacts({world} = {}) {
  if (!world) return;
  const staged = stagedImpacts.get(world) || [];
  for (const item of staged) {
    const result = applyRoutedVesselImpact(item.entry, item.descriptor);
    if (result?.mode !== "zonal") continue;
    decorateNotice(item.entry, item.event, result);
    decoratePairedDamageNotice(world, item.entry, item.event, result);
  }
  stagedImpacts.delete(world);
  legacyFrames.delete(world);
}

function waterZones(entry) {
  const result = [];
  for (const deck of entry?.definition?.decks || []) {
    for (const zone of deck.zones || []) if (zone?.water?.enabled) result.push(zone);
  }
  return result;
}

function syncCompatibilityWater(entry) {
  const zones = waterZones(entry);
  if (!zones.length) return;
  const states = zones.map(zone => entry.instance?.zones?.[zone.id] || {});
  entry.boat.water = states.reduce((sum, state) => sum + clamp(state.flooding, 0, 100), 0) / states.length;
  entry.boat.leak = clamp(states.reduce((sum, state) => sum + Math.max(0, Number(state.leakRate) || 0), 0), 0, 16);
}

function decorateBlastEvent(entry, request, result) {
  const event = request?.event;
  if (!event || !result?.impacts?.length) return;
  const primary = result.impacts[0];
  const labels = result.impacts.map(item => item.zoneLabel).filter(Boolean);
  Object.assign(event, {
    vesselZonalImpact: true,
    zoneId: primary.zoneId,
    zoneLabel: primary.zoneLabel,
    affectedZoneIds: result.impacts.map(item => item.zoneId),
    affectedZoneLabels: labels,
    moduleId: primary.moduleId || null,
    hull: entry.boat.hull,
    hullMax: entry.boat.hullMax,
    armor: entry.boat.armor,
    armorMax: entry.boat.armorMax,
  });
  if (labels.length) {
    event.text = labels.length === 1
      ? `Мега-бомба ударила в ${zoneAccusative(entry, primary.zoneId)}. Корпус ${Math.round(entry.boat.hull)} из ${Math.round(Math.max(1, Number(entry.boat.hullMax) || 100))}.`
      : `Мега-бомба повредила отсеки: ${labels.join(", ")}. Корпус ${Math.round(entry.boat.hull)} из ${Math.round(Math.max(1, Number(entry.boat.hullMax) || 100))}.`;
  }
}

function applyExternalImpacts({world, nativeVessels} = {}) {
  if (!world) return;
  const requests = drainExternalVesselImpacts(world);
  if (!requests.length) return;
  const byBoat = new Map();
  for (const request of requests) {
    const key = String(request.boatId);
    if (!byBoat.has(key)) byBoat.set(key, []);
    byBoat.get(key).push(request);
  }

  for (const [boatId, batch] of byBoat) {
    const entry = (nativeVessels || []).find(candidate => String(candidate?.boat?.id) === boatId);
    if (!routedEntry(entry)) continue;
    const baseline = batch[0]?.baseline;
    if (baseline) {
      entry.boat.hull = Math.max(0, Number(baseline.hull) || 0);
      entry.boat.armor = Math.max(0, Number(baseline.armor) || 0);
      entry.boat.leak = Math.max(0, Number(baseline.leak) || 0);
      entry.boat.water = clamp(baseline.water, 0, 100);
    }

    for (const request of batch) {
      entry.boat.armor = Math.max(0, (Number(entry.boat.armor) || 0) - Math.max(0, Number(request.armorDamage) || 0));
      const result = applyRoutedVesselBlast(entry, {
        legacyHullDamage: Math.max(0, Number(request.hullDamage) || 0),
        leak: Math.max(0, Number(request.leak) || 0),
        flooding: Math.max(0, Number(request.flooding) || 0) * Math.max(1, waterZones(entry).length),
        fire: Math.max(0, Number(request.fire) || 0),
        impactPoint: request.impactPoint,
        sourcePoint: request.sourcePoint,
        blastRadius: request.blastRadius,
      });
      decorateBlastEvent(entry, request, result);
    }
    syncCompatibilityWater(entry);
  }
}

export const VESSEL_IMPACT_ROUTING_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-impact-routing-snapshot-v1",
    phase: "before-step",
    order: 49,
    run: snapshotLegacyFrame,
  }),
  Object.freeze({
    id: "vessel-impact-routing-capture-legacy-v1",
    phase: "after-step",
    order: 11,
    run: captureLegacyBulletImpacts,
  }),
  Object.freeze({
    id: "vessel-impact-routing-apply-legacy-v1",
    phase: "after-step",
    order: 13,
    run: applyStagedBulletImpacts,
  }),
  Object.freeze({
    id: "vessel-impact-routing-external-v1",
    phase: "external-impact",
    order: 0,
    run: applyExternalImpacts,
  }),
]);

export {
  applyExternalImpacts,
  applyStagedBulletImpacts,
  captureLegacyBulletImpacts,
  snapshotLegacyFrame,
};
