"use strict";

import {dropCarriedCrate} from "../free-roam-activities.js?v=44";
import {applyCombatDamage} from "../free-roam-combat-v2.js?v=6";
import {pointInShape} from "./vessel-deck-compiler.js";
import {applyVesselDamage} from "./vessel-damage.js";
import {resolveVesselZoneAt} from "./vessel-deck-runtime.js";
import {setVesselOccupantPosition, worldToVesselLocal} from "./vessel-interior.js";

export const VESSEL_SPATIAL_DAMAGE_VERSION = "1.0.0";

export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
export const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const point = value => Array.isArray(value) ? {x: finite(value[0]), y: finite(value[1])} : {x: finite(value?.x), y: finite(value?.y)};
const snapshots = new WeakMap();

function snapshotBucket(world) {
  let bucket = snapshots.get(world);
  if (!bucket) {
    bucket = new Map();
    snapshots.set(world, bucket);
  }
  return bucket;
}

export function snapshotFor(world, scope = "world-step") {
  return snapshots.get(world)?.get(scope) || null;
}

export function freshEvents(world, eventStart = 0, scope = "world-step") {
  const snapshot = snapshotFor(world, scope);
  const current = values(world?.events);
  if (!snapshot?.eventObjects) return current.slice(eventStart || 0);
  return current.filter(event => !snapshot.eventObjects.has(event));
}

export function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, vesselSpatialDamageVersion: VESSEL_SPATIAL_DAMAGE_VERSION, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deckHeight(definition, deck) {
  const spacing = Math.max(0.8, finite(definition?.damage?.deckHeight, 1.65));
  return Math.max(0.45, 0.7 + finite(deck?.level) * spacing);
}

function shapeCentre(shape) {
  const points = values(shape?.outer);
  if (!points.length) return {x: 0, y: 0};
  let x = 0, y = 0;
  for (const point of points) { x += finite(point?.x); y += finite(point?.y); }
  return {x: x / points.length, y: y / points.length};
}

export function distance(a, b) {
  const left = point(a), right = point(b);
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function deckCandidates(definition, local) {
  const decks = values(definition?.decks);
  const contained = decks.filter(deck => pointInShape(local, deck.shape));
  return contained.length ? contained : decks;
}

function preferredDeckFromPlayer(entry, playerIndex) {
  if (!Number.isInteger(playerIndex)) return null;
  const local = entry?.instance?.occupants?.[playerIndex];
  if (!local) return null;
  return values(entry.definition?.decks).find(deck => deck.id === local.deckId) || null;
}

function selectImpactDeck(entry, local, descriptor = {}) {
  const candidates = deckCandidates(entry.definition, local);
  if (!candidates.length) return null;
  if (descriptor.deckId) {
    const explicit = candidates.find(deck => deck.id === descriptor.deckId) || values(entry.definition.decks).find(deck => deck.id === descriptor.deckId);
    if (explicit) return explicit;
  }
  const targeted = preferredDeckFromPlayer(entry, descriptor.targetPlayer);
  if (targeted && candidates.some(deck => deck.id === targeted.id) && descriptor.preferTargetDeck !== false) return targeted;
  if (Number.isFinite(Number(descriptor.deckLevel))) {
    return [...candidates].sort((a, b) => Math.abs(finite(a.level) - finite(descriptor.deckLevel)) - Math.abs(finite(b.level) - finite(descriptor.deckLevel)))[0];
  }
  if (Number.isFinite(Number(descriptor.impactHeight))) {
    return [...candidates].sort((a, b) => Math.abs(deckHeight(entry.definition, a) - finite(descriptor.impactHeight)) - Math.abs(deckHeight(entry.definition, b) - finite(descriptor.impactHeight)))[0];
  }
  if (descriptor.fromAbove) return [...candidates].sort((a, b) => finite(b.level) - finite(a.level))[0];
  if (descriptor.kind === "ram") return [...candidates].sort((a, b) => finite(a.level) - finite(b.level))[0];
  const ordered = [...candidates].sort((a, b) => finite(a.level) - finite(b.level));
  return ordered[hashString(descriptor.projectileId || descriptor.sourceId || descriptor.kind) % ordered.length];
}

function projectImpactToHull(entry, deck, local, descriptor = {}) {
  if (!deck?.shape?.outer || !descriptor.sourcePoint) return local;
  if (distance(local, {x: 0, y: 0}) > 0.85) return local;
  const sourceLocal = worldToVesselLocal(entry.boat, descriptor.sourcePoint);
  const length = Math.hypot(sourceLocal.x, sourceLocal.y);
  if (length < 0.1) return local;
  const dx = sourceLocal.x / length;
  const dy = sourceLocal.y / length;
  const ring = values(deck.shape.outer).map(point);
  if (!ring.length) return local;
  const minX = Math.min(...ring.map(item => item.x));
  const maxX = Math.max(...ring.map(item => item.x));
  const minY = Math.min(...ring.map(item => item.y));
  const maxY = Math.max(...ring.map(item => item.y));
  const candidates = [];
  if (dx > 0.001) candidates.push(maxX / dx);
  else if (dx < -0.001) candidates.push(minX / dx);
  if (dy > 0.001) candidates.push(maxY / dy);
  else if (dy < -0.001) candidates.push(minY / dy);
  const scale = Math.min(...candidates.filter(value => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(scale)) return local;
  const projected = {x: dx * scale * 0.88, y: dy * scale * 0.88};
  return pointInShape(projected, deck.shape) ? projected : local;
}

function resolveZone(entry, deck, local) {
  if (!deck) return null;
  const direct = resolveVesselZoneAt(entry.definition, deck.id, local);
  if (direct) return direct;
  const zones = values(deck.zones);
  if (!zones.length) return null;
  return [...zones].sort((a, b) => distance(local, shapeCentre(a.shape)) - distance(local, shapeCentre(b.shape)))[0];
}

function moduleDefinition(entry, moduleId) {
  return values(entry?.definition?.modules).find(module => module.id === moduleId) || null;
}

export function modulePosition(entry, moduleId) {
  const damage = entry?.definition?.damage || {};
  const explicit = damage.moduleLocations?.[moduleId];
  if (explicit?.deckId && explicit.position) return {deckId: explicit.deckId, position: point(explicit.position)};
  const module = moduleDefinition(entry, moduleId);
  for (const mountId of values(module?.mounts)) {
    const mount = values(entry.definition?.mounts).find(candidate => candidate.id === mountId);
    if (mount?.deckId && mount?.position) return {deckId: mount.deckId, position: mount.position};
  }
  for (const deck of values(entry.definition?.decks)) {
    for (const object of values(deck.objects)) {
      if (object.controlsModule === moduleId && object.position) return {deckId: deck.id, position: object.position};
      if (moduleId === "helm" && object.controlsVessel === true && object.position) return {deckId: deck.id, position: object.position};
    }
  }
  return null;
}

function candidateModules(entry, zoneId, deckId) {
  const damage = entry?.definition?.damage || {};
  const configured = values(damage.zoneModuleChoices?.[zoneId] || damage.zoneModules?.[zoneId]);
  if (configured.length) return configured.filter(id => entry.instance?.modules?.[id]);
  const result = [];
  for (const module of values(entry.definition?.modules)) {
    const location = modulePosition(entry, module.id);
    if (location?.deckId === deckId && entry.instance?.modules?.[module.id]) result.push(module.id);
  }
  return result;
}

function chooseModules(entry, zoneId, deckId, local, kind) {
  const ids = candidateModules(entry, zoneId, deckId);
  if (!ids.length) return [];
  ids.sort((leftId, rightId) => {
    const leftPosition = modulePosition(entry, leftId);
    const rightPosition = modulePosition(entry, rightId);
    const leftDistance = leftPosition ? distance(local, leftPosition.position) : 999;
    const rightDistance = rightPosition ? distance(local, rightPosition.position) : 999;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    const leftHealth = finite(entry.instance.modules[leftId]?.health, 100);
    const rightHealth = finite(entry.instance.modules[rightId]?.health, 100);
    if (leftHealth !== rightHealth) return rightHealth - leftHealth;
    return leftId.localeCompare(rightId);
  });
  const count = kind === "blast" ? Math.min(3, ids.length) : 1;
  return ids.slice(0, count);
}

function armorProfile(definition, kind) {
  const profile = definition?.damage?.armorProtection || {};
  const protection = clamp(profile[kind] ?? profile.default ?? (kind === "blast" ? 0.68 : kind === "ram" ? 0.42 : 0.82), 0, 0.96);
  const demand = Math.max(0.15, finite(definition?.damage?.armorDemand?.[kind], kind === "blast" ? 0.9 : kind === "ram" ? 0.55 : 1));
  return {protection, demand};
}

function applyArmor(entry, amount, kind) {
  const armor = Math.max(0, finite(entry.boat?.armor));
  if (armor <= 0 || amount <= 0) return {armorDamage: 0, transmission: 1};
  const profile = armorProfile(entry.definition, kind);
  const demand = amount * profile.demand;
  const armorDamage = Math.min(armor, demand);
  const coverage = demand > 0 ? clamp(armorDamage / demand, 0, 1) : 0;
  entry.boat.armor = Math.max(0, armor - armorDamage);
  return {armorDamage, transmission: clamp(1 - coverage * profile.protection, 0.06, 1)};
}

function damageModule(entry, moduleId, amount) {
  const state = entry.instance?.modules?.[moduleId];
  if (!state || amount <= 0) return null;
  const before = finite(state.health, 100);
  state.health = clamp(before - amount, 0, 100);
  if (state.health <= 0) state.enabled = false;
  return {moduleId, before, health: state.health, damage: before - state.health, disabled: before > 0 && state.health <= 0};
}

function zoneState(entry, zoneId) {
  if (!zoneId) return null;
  entry.instance.zones ||= {};
  entry.instance.zones[zoneId] ||= {health: 100, flooding: 0, fire: 0, leakRate: 0};
  return entry.instance.zones[zoneId];
}

function audienceForEntry(world, entry) {
  const result = [];
  for (let index = 0; index < values(world?.players).length; index += 1) {
    if (String(world.players?.[index]?.activeBoat) === String(entry.boat.id) || entry.instance?.occupants?.[index]) result.push(index);
  }
  return result;
}

export function moduleUserLabel(entry, moduleId) {
  const module = moduleDefinition(entry, moduleId);
  if (module?.config?.label) return String(module.config.label);
  if (String(moduleId).startsWith("engine-")) return "двигатель";
  const labels = {
    engine: "двигатель", helm: "рулевое управление", "bilge-pump": "трюмная помпа",
    repair: "ремонтная станция", fuel: "топливная система", cargo: "грузовой отсек",
    sonar: "сонар", "port-turret": "левая установка", "starboard-turret": "правая установка",
  };
  return labels[moduleId] || String(moduleId);
}

function announceThresholds(world, entry, deck, zone, beforeZoneHealth, moduleResults) {
  const after = zone ? finite(entry.instance?.zones?.[zone.id]?.health, 100) : 100;
  const thresholds = [75, 50, 25, 0];
  const crossed = thresholds.find(value => beforeZoneHealth > value && after <= value);
  const disabled = moduleResults.find(result => result?.disabled);
  if (crossed === undefined && !disabled) return;
  const targets = audienceForEntry(world, entry);
  const zoneLabel = zone?.presentation?.label || zone?.label || deck?.presentation?.label || deck?.label || "отсек";
  let text = crossed === 0 ? `${zoneLabel}: конструкция разрушена.` : `${zoneLabel}: прочность ${Math.round(after)}.`;
  if (disabled) {
    const label = moduleUserLabel(entry, disabled.moduleId);
    text += ` ${label} выведен из строя.`;
  }
  emit(world, "vessel-zone-damage-notice", text, targets, {
    boatId: entry.boat.id,
    deckId: deck?.id || null,
    zoneId: zone?.id || null,
    zoneHealth: after,
    moduleId: disabled?.moduleId || null,
  });
}

export function occupantDamageScale(entry, occupant, deck, localImpact, descriptor, transmission) {
  if (!occupant || occupant.deckId !== deck?.id) return 0;
  const metres = distance(occupant, localImpact);
  const radius = descriptor.kind === "blast" ? Math.max(3, finite(descriptor.internalRadius, 8.5))
    : descriptor.kind === "ram" ? 4.5 : 3.2;
  if (metres > radius) return 0;
  const distanceFactor = clamp(1 - metres / Math.max(0.1, radius), descriptor.kind === "blast" ? 0.16 : 0.25, 1);
  const cover = clamp(finite(entry.definition?.damage?.internalCover?.[deck.id], deck.level > 0 ? 0.9 : 0.78), 0.35, 1);
  return distanceFactor * transmission * cover;
}

function damageOccupants(world, entry, deck, localImpact, descriptor, transmission) {
  const results = [];
  const candidates = [];
  for (const [rawIndex, occupant] of Object.entries(entry.instance?.occupants || {})) {
    const playerIndex = Number(rawIndex);
    const player = world?.players?.[playerIndex];
    if (!Number.isInteger(playerIndex) || !player?.combat?.alive) continue;
    const scale = occupantDamageScale(entry, occupant, deck, localImpact, descriptor, transmission);
    if (scale <= 0) continue;
    candidates.push({playerIndex, player, occupant, scale, metres: distance(occupant, localImpact)});
  }
  candidates.sort((a, b) => a.metres - b.metres);
  const selected = descriptor.kind === "bullet" || descriptor.kind === "heavy-bullet" ? candidates.slice(0, 1) : candidates;
  for (const candidate of selected) {
    const base = Math.max(0, finite(descriptor.playerDamage, descriptor.damage * (descriptor.kind === "blast" ? 0.46 : descriptor.kind === "ram" ? 0.22 : 0.5)));
    const amount = base * candidate.scale;
    if (amount <= 0.35) continue;
    applyCombatDamage(world, candidate.playerIndex, amount, -1, {
      weapon: descriptor.weapon || `vessel-${descriptor.kind}`,
      heavy: descriptor.kind === "blast" || descriptor.kind === "ram" || descriptor.kind === "heavy-bullet",
      eventType: "vessel-spatial-player-hit",
      sourcePoint: descriptor.sourcePoint || descriptor.impactPoint,
      announceHealth: descriptor.announceHealth !== false,
    }, {dropCarriedCrate});
    results.push({playerIndex: candidate.playerIndex, damage: amount});
  }
  return results;
}

export function applySpatialVesselImpact(world, entry, descriptor = {}) {
  if (!world || !entry?.boat || !entry?.definition?.capabilities?.walkableInterior || !entry.definition?.decks?.length) return null;
  const impactPoint = descriptor.impactPoint || entry.boat;
  const rawLocal = worldToVesselLocal(entry.boat, impactPoint);
  const deck = selectImpactDeck(entry, rawLocal, descriptor);
  if (!deck) return null;
  const local = projectImpactToHull(entry, deck, rawLocal, descriptor);
  const zone = resolveZone(entry, deck, local);
  const amount = Math.max(0, finite(descriptor.damage));
  if (amount <= 0) return null;
  const beforeZoneHealth = finite(zoneState(entry, zone?.id)?.health, 100);
  const armor = applyArmor(entry, amount, descriptor.kind || "bullet");
  const structural = amount * armor.transmission;
  const flooding = descriptor.kind === "blast" ? structural * 0.16 : descriptor.kind === "ram" ? structural * 0.09 : structural * 0.025;
  const leak = descriptor.kind === "blast" ? structural * 0.045 : descriptor.kind === "ram" ? structural * 0.035 : structural * 0.012;
  const result = applyVesselDamage(entry.definition, entry.instance, entry.boat, {
    damage: structural,
    zoneId: zone?.id || null,
    flooding,
    leak,
  });
  const moduleIds = chooseModules(entry, zone?.id, deck.id, local, descriptor.kind);
  const moduleResults = moduleIds.map((moduleId, index) => damageModule(entry, moduleId, structural * (descriptor.kind === "blast" ? (index === 0 ? 0.72 : 0.34) : descriptor.kind === "ram" ? 0.28 : 0.42))).filter(Boolean);
  const occupantResults = descriptor.damagePlayers === false ? [] : damageOccupants(world, entry, deck, local, descriptor, armor.transmission);
  announceThresholds(world, entry, deck, zone, beforeZoneHealth, moduleResults);
  return {
    version: VESSEL_SPATIAL_DAMAGE_VERSION,
    boatId: entry.boat.id,
    kind: descriptor.kind || "bullet",
    deckId: deck.id,
    deckLabel: deck.presentation?.label || deck.label || deck.id,
    zoneId: zone?.id || null,
    zoneLabel: zone?.presentation?.label || zone?.label || null,
    localImpact: {x: local.x, y: local.y},
    armorDamage: armor.armorDamage,
    transmission: armor.transmission,
    structuralDamage: structural,
    hullDamage: finite(result?.hullDamage),
    hull: entry.boat.hull,
    armor: entry.boat.armor,
    modules: moduleResults,
    players: occupantResults,
  };
}

function copyCombat(player) {
  const combat = player?.combat;
  if (!combat) return null;
  return {
    health: finite(combat.health, 100), alive: combat.alive !== false, stun: finite(combat.stun),
    knockedDown: Boolean(combat.knockedDown), knockdownRemaining: finite(combat.knockdownRemaining),
    respawnRemaining: finite(combat.respawnRemaining), pendingDamage: finite(combat.pendingDamage),
    carriedCrate: combat.carriedCrate || null,
    mode: player.mode, activeBoat: player.activeBoat, vesselDeckInputOwned: Boolean(player.vesselDeckInputOwned),
    x: finite(player.x), y: finite(player.y), heading: finite(player.heading),
  };
}

export function captureVesselSpatialDamageState(world, nativeVessels = [], scope = "world-step") {
  const boats = new Map();
  for (const entry of nativeVessels) {
    if (!entry?.definition?.capabilities?.walkableInterior || !entry.definition?.decks?.length) continue;
    boats.set(String(entry.boat.id), {
      hull: finite(entry.boat.hull), hullMax: Math.max(1, finite(entry.boat.hullMax, 100)), armor: finite(entry.boat.armor),
      leak: finite(entry.boat.leak), water: finite(entry.boat.water),
      driver: entry.boat.driver, crew: Array.isArray(entry.boat.crew) ? [...entry.boat.crew] : [],
      throttle: finite(entry.boat.throttle), rudder: finite(entry.boat.rudder),
      occupants: Object.fromEntries(Object.entries(entry.instance?.occupants || {}).map(([key, value]) => [key, {...value}])),
    });
  }
  const players = values(world?.players).map(copyCombat);
  const crates = new Map(values(world?.freeActivities?.crates).map(crate => [String(crate?.id), {
    state: crate?.state, carriedBy: crate?.carriedBy ?? null, stowedBoat: crate?.stowedBoat ?? null,
    x: finite(crate?.x), y: finite(crate?.y),
  }]));
  const snapshot = {boats, players, crates, eventObjects: new Set(values(world?.events))};
  snapshotBucket(world).set(scope, snapshot);
  return snapshot;
}
