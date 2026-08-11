"use strict";

import {worldToVesselLocal} from "./vessel-interior.js";
import {applyVesselDamage} from "./vessel-damage.js";

const externalImpactQueues = new WeakMap();
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function point(value) {
  if (Array.isArray(value)) return {x: Number(value[0]) || 0, y: Number(value[1]) || 0};
  return {x: Number(value?.x) || 0, y: Number(value?.y) || 0};
}

function finitePoint(value) {
  return Boolean(value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)));
}

function polygonContains(rawPoint, vertices = []) {
  if (!Array.isArray(vertices) || vertices.length < 3) return false;
  const test = point(rawPoint);
  let inside = false;
  for (let left = 0, right = vertices.length - 1; left < vertices.length; right = left++) {
    const a = point(vertices[left]);
    const b = point(vertices[right]);
    const intersects = ((a.y > test.y) !== (b.y > test.y))
      && test.x < (b.x - a.x) * (test.y - a.y) / ((b.y - a.y) || 1e-9) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonCenter(vertices = []) {
  if (!Array.isArray(vertices) || !vertices.length) return {x: 0, y: 0};
  const values = vertices.map(point);
  return {
    x: values.reduce((sum, item) => sum + item.x, 0) / values.length,
    y: values.reduce((sum, item) => sum + item.y, 0) / values.length,
  };
}

function allZones(definition) {
  return (definition?.decks || []).flatMap(deck => (deck.zones || []).map(zone => ({deck, zone})));
}

function zoneRecord(definition, zoneId) {
  return allZones(definition).find(item => item.zone.id === zoneId) || null;
}

function impactRegions(definition) {
  return (definition?.damage?.impactRegions || [])
    .filter(region => region?.zoneId && zoneRecord(definition, region.zoneId));
}

function regionAnchor(region) {
  return region?.blastAnchor ? point(region.blastAnchor) : polygonCenter(region?.shape?.outer || []);
}

function regionAtLocal(definition, local) {
  return impactRegions(definition).find(region => polygonContains(local, region?.shape?.outer || [])) || null;
}

function nearestRegion(definition, local) {
  let best = null;
  let bestDistance = Infinity;
  for (const region of impactRegions(definition)) {
    const anchor = regionAnchor(region);
    const metres = Math.hypot(local.x - anchor.x, local.y - anchor.y);
    if (metres < bestDistance) {
      bestDistance = metres;
      best = region;
    }
  }
  return best;
}

function incomingSide(boat, sourcePoint) {
  if (!finitePoint(sourcePoint)) return null;
  const absolute = Math.atan2(
    Number(sourcePoint.x) - (Number(boat?.x) || 0),
    -(Number(sourcePoint.y) - (Number(boat?.y) || 0)),
  ) * 180 / Math.PI;
  const relative = Math.abs(((absolute - (Number(boat?.heading) || 0) + 180) % 360 + 360) % 360 - 180);
  if (relative <= 60) return "front";
  if (relative >= 120) return "rear";
  return "side";
}

function boundaryImpact(boat, sourcePoint) {
  if (!finitePoint(sourcePoint)) return null;
  const dx = Number(sourcePoint.x) - (Number(boat?.x) || 0);
  const dy = Number(sourcePoint.y) - (Number(boat?.y) || 0);
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return null;
  const radius = Math.max(2, Number(boat?.collisionRadius) || 6.5);
  return {
    x: (Number(boat?.x) || 0) + dx / length * radius * 0.96,
    y: (Number(boat?.y) || 0) + dy / length * radius * 0.96,
  };
}

function resolvedWorldImpact(entry, descriptor = {}) {
  const boat = entry?.boat;
  const supplied = descriptor.impactPoint;
  if (finitePoint(supplied)) {
    const centreDistance = Math.hypot(
      Number(supplied.x) - (Number(boat?.x) || 0),
      Number(supplied.y) - (Number(boat?.y) || 0),
    );
    // Old hitscan events only reported the target boat centre. Recover the
    // entry point from the shooter instead of treating every such hit as midships.
    if (centreDistance > 0.75 || !finitePoint(descriptor.sourcePoint)) return point(supplied);
  }
  return boundaryImpact(boat, descriptor.sourcePoint)
    || (finitePoint(supplied) ? point(supplied) : point(boat));
}

export function vesselSupportsRoutedDamage(entry) {
  return Boolean(
    entry?.definition?.capabilities?.zonalDamage === true
    && entry.definition?.damage?.mode === "zonal"
    && entry?.boat
    && entry?.instance,
  );
}

export function resolveVesselImpactZone(entry, descriptor = {}) {
  if (!vesselSupportsRoutedDamage(entry)) return null;
  const explicit = descriptor.zoneId ? zoneRecord(entry.definition, descriptor.zoneId) : null;
  const worldImpact = resolvedWorldImpact(entry, descriptor);
  const localImpact = worldToVesselLocal(entry.boat, worldImpact);
  let region = explicit ? null : regionAtLocal(entry.definition, localImpact);
  if (!explicit && !region && impactRegions(entry.definition).length) region = nearestRegion(entry.definition, localImpact);
  const side = incomingSide(entry.boat, descriptor.sourcePoint);
  const directionalId = side ? entry.definition?.damage?.directionalZones?.[side] : null;
  const fallback = explicit
    || (region ? zoneRecord(entry.definition, region.zoneId) : null)
    || (directionalId ? zoneRecord(entry.definition, directionalId) : null)
    || allZones(entry.definition)[0]
    || null;
  if (!fallback) return null;
  return Object.freeze({
    zoneId: fallback.zone.id,
    zoneLabel: fallback.zone.label || fallback.zone.id,
    deckId: fallback.deck.id,
    worldImpact,
    localImpact,
    side,
  });
}

export function damageableVesselModule(entry, zoneId) {
  if (!zoneId) return null;
  const damage = entry?.definition?.damage || {};
  const configuredChoices = Array.isArray(damage.zoneModuleChoices?.[zoneId])
    ? damage.zoneModuleChoices[zoneId]
    : [];
  const valid = configuredChoices.filter(moduleId => entry.instance?.modules?.[moduleId]);
  if (valid.length) {
    valid.sort((leftId, rightId) => {
      const left = Number(entry.instance.modules[leftId]?.health);
      const right = Number(entry.instance.modules[rightId]?.health);
      const leftHealth = Number.isFinite(left) ? left : 100;
      const rightHealth = Number.isFinite(right) ? right : 100;
      if (rightHealth !== leftHealth) return rightHealth - leftHealth;
      return String(leftId).localeCompare(String(rightId));
    });
    return valid[0];
  }
  const configured = damage.zoneModules?.[zoneId];
  return configured && entry.instance?.modules?.[configured] ? configured : null;
}

function structuralDamage(entry, descriptor) {
  const legacyHullDamage = Number(descriptor?.legacyHullDamage);
  if (Number.isFinite(legacyHullDamage)) {
    const hullShare = clamp(entry.definition?.damage?.hullShare ?? 0.25, 0.01, 1);
    return Math.max(0, legacyHullDamage) / hullShare;
  }
  return Math.max(0, Number(descriptor?.damage) || 0);
}

export function applyRoutedVesselImpact(entry, descriptor = {}) {
  if (!vesselSupportsRoutedDamage(entry)) return Object.freeze({mode: "ignored", reason: "not-zonal"});
  const resolved = resolveVesselImpactZone(entry, descriptor);
  if (!resolved) return Object.freeze({mode: "ignored", reason: "no-zone"});
  const moduleId = descriptor.moduleId || damageableVesselModule(entry, resolved.zoneId);
  const result = applyVesselDamage(entry.definition, entry.instance, entry.boat, {
    damage: structuralDamage(entry, descriptor),
    zoneId: resolved.zoneId,
    moduleId,
    flooding: Math.max(0, Number(descriptor.flooding) || 0),
    leak: Math.max(0, Number(descriptor.leak) || 0),
    fire: Math.max(0, Number(descriptor.fire) || 0),
  });
  return Object.freeze({...result, ...resolved, moduleId});
}

function normalizedBlastRegions(entry, descriptor, localImpact) {
  const regions = impactRegions(entry.definition);
  if (!regions.length) return [];
  const radius = Math.max(1, Number(descriptor.blastRadius) || 18);
  const weighted = regions.map(region => {
    const anchor = regionAnchor(region);
    const distance = Math.hypot(localImpact.x - anchor.x, localImpact.y - anchor.y);
    const influence = clamp(1 - distance / radius, 0, 1);
    return {region, distance, influence};
  }).filter(item => item.influence > 0.001);
  if (!weighted.length) {
    const nearest = nearestRegion(entry.definition, localImpact);
    return nearest ? [{region: nearest, distance: 0, influence: 1, weight: 1}] : [];
  }
  const total = weighted.reduce((sum, item) => sum + item.influence, 0) || 1;
  return weighted.map(item => ({...item, weight: item.influence / total}));
}

export function applyRoutedVesselBlast(entry, descriptor = {}) {
  if (!vesselSupportsRoutedDamage(entry)) return Object.freeze({mode: "ignored", reason: "not-zonal", impacts: []});
  const worldImpact = resolvedWorldImpact(entry, descriptor);
  const localImpact = worldToVesselLocal(entry.boat, worldImpact);
  const weighted = normalizedBlastRegions(entry, descriptor, localImpact);
  if (!weighted.length) {
    const single = applyRoutedVesselImpact(entry, descriptor);
    return Object.freeze({mode: single.mode, primaryZoneId: single.zoneId || null, impacts: [single]});
  }

  const totalDamage = structuralDamage(entry, descriptor);
  const totalLeak = Math.max(0, Number(descriptor.leak) || 0);
  const totalFlooding = Math.max(0, Number(descriptor.flooding) || 0);
  const totalFire = Math.max(0, Number(descriptor.fire) || 0);
  const impacts = [];
  for (const item of weighted) {
    const zoneId = item.region.zoneId;
    const moduleId = damageableVesselModule(entry, zoneId);
    const result = applyVesselDamage(entry.definition, entry.instance, entry.boat, {
      damage: totalDamage * item.weight,
      zoneId,
      moduleId,
      leak: totalLeak * item.weight,
      flooding: totalFlooding * item.weight,
      fire: totalFire * item.weight,
    });
    const record = zoneRecord(entry.definition, zoneId);
    impacts.push(Object.freeze({
      ...result,
      zoneId,
      zoneLabel: record?.zone?.label || zoneId,
      deckId: record?.deck?.id || null,
      moduleId,
      weight: item.weight,
      distance: item.distance,
      worldImpact,
      localImpact,
    }));
  }
  impacts.sort((left, right) => right.weight - left.weight);
  return Object.freeze({
    mode: "zonal-blast",
    primaryZoneId: impacts[0]?.zoneId || null,
    worldImpact,
    localImpact,
    impacts: Object.freeze(impacts),
  });
}

export function queueExternalVesselImpact(world, descriptor = {}) {
  if (!world || descriptor?.boatId == null) return false;
  let queue = externalImpactQueues.get(world);
  if (!queue) {
    queue = [];
    externalImpactQueues.set(world, queue);
  }
  queue.push(descriptor);
  return true;
}

export function drainExternalVesselImpacts(world) {
  const queue = externalImpactQueues.get(world) || [];
  externalImpactQueues.delete(world);
  return queue;
}
