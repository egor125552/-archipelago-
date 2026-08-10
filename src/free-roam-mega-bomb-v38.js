"use strict";

import * as base from "./free-roam-mega-bomb-v37.js?v=3";
import {queueExternalVesselImpact} from "../public/src/vessel/vessel-impact-routing.js?v=1";
import {runVesselSystems} from "../public/src/vessel/vessel-runtime.js?v=2";

export * from "./free-roam-mega-bomb-v37.js?v=3";

export const MEGA_BOMB_PLAYER_BOAT_ARMOR_VERSION = "1.1.0";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];

function playerPoint(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function worldSpacePan(listener, source) {
  const dx = (Number(source?.x) || 0) - (Number(listener?.x) || 0);
  const dy = (Number(source?.y) || 0) - (Number(listener?.y) || 0);
  const metres = Math.hypot(dx, dy);
  if (metres < 0.001) return 0;
  return clamp(dx / Math.max(metres, 8), -1, 1);
}

function normalizeFootSpatial(world, event) {
  if (!event || !Array.isArray(event.spatial)) return event;
  if (!Number.isFinite(Number(event.x)) || !Number.isFinite(Number(event.y))) return event;
  for (let index = 0; index < event.spatial.length; index += 1) {
    const player = world?.players?.[index];
    if (!player || !["foot", "swim"].includes(player.mode)) continue;
    const listener = playerPoint(world, index);
    if (!listener) continue;
    event.spatial[index] ||= {};
    // On foot the listener has no independent camera/vehicle heading. Walking
    // left or right changes player.heading, but must not rotate the entire sound
    // field. Pan therefore comes only from source/listener world coordinates.
    event.spatial[index].pan = worldSpacePan(listener, event);
    event.spatial[index].listenerX = Number(listener.x) || 0;
    event.spatial[index].listenerY = Number(listener.y) || 0;
  }
  return event;
}

function normalizeFreshSpatial(world, eventStart) {
  for (const event of values(world?.events).slice(eventStart)) normalizeFootSpatial(world, event);
}

function boatSnapshots(world) {
  const result = new Map();
  for (const boat of values(world?.boats)) {
    if (!boat || !Number.isFinite(Number(boat.id))) continue;
    const snapshot = {
      hull: Math.max(0, Number(boat.hull) || 0),
      hullMax: Math.max(1, Number(boat.hullMax) || 100),
      armor: Math.max(0, Number(boat.armor) || 0),
      armorMax: Math.max(0, Number(boat.armorMax) || 0),
      leak: Math.max(0, Number(boat.leak) || 0),
      water: clamp(boat.water, 0, 100),
    };
    result.set(String(boat.id), {...snapshot, baseline: Object.freeze({...snapshot})});
  }
  return result;
}

function boatById(world, id) {
  return values(world?.boats).find(boat => String(boat?.id) === String(id)) || null;
}

function explosionByProjectile(world, eventStart) {
  return new Map(values(world?.events).slice(eventStart)
    .filter(event => event?.type === "mega-bomb-explosion")
    .map(event => [String(event.projectileId || ""), event]));
}

function rebalancePlayerBoatBombHits(world, eventStart, states) {
  const hitEvents = values(world?.events).slice(eventStart)
    .filter(event => event?.type === "mega-bomb-boat-hit" && event.boatId != null);
  const explosions = explosionByProjectile(world, eventStart);

  for (const event of hitEvents) {
    const key = String(event.boatId);
    const state = states.get(key);
    const boat = boatById(world, event.boatId);
    if (!state || !boat) continue;

    // Legacy mega-bomb damage stored only rounded hull damage (= raw * .55).
    // Reconstruct enough blast energy to preserve the existing balance while
    // routing an armored patrol's impact through armor before structural hull.
    const raw = Math.max(0, Number(event.damage) || 0) / 0.55;
    const nominalHullDamage = raw * 0.55;
    const nominalArmorDamage = raw * 0.72;
    const armorDamage = state.armor > 0
      ? Math.min(state.armor, nominalArmorDamage)
      : 0;
    const armorCoverage = nominalArmorDamage > 0
      ? clamp(armorDamage / nominalArmorDamage, 0, 1)
      : 0;
    const hullDamage = nominalHullDamage * (1 - armorCoverage * 0.68);
    const penetration = 1 - armorCoverage * 0.72;
    const leakIncrease = raw * 0.045 * penetration;
    const floodingIncrease = raw * 0.08 * penetration;

    state.armor = Math.max(0, state.armor - armorDamage);
    state.hull = clamp(state.hull - hullDamage, 0, state.hullMax);
    state.leak = clamp(state.leak + leakIncrease, 0, 24);
    state.water = clamp(state.water + floodingIncrease, 0, 100);

    boat.armor = state.armor;
    boat.hull = state.hull;
    boat.leak = state.leak;
    boat.water = state.water;

    event.damage = Math.round(hullDamage);
    event.armorDamage = Math.round(armorDamage);
    event.armor = Math.round(state.armor);
    event.armorMax = Math.round(state.armorMax);
    event.hull = state.hull;
    event.hullMax = state.hullMax;
    event.megaBombPlayerBoatArmorVersion = MEGA_BOMB_PLAYER_BOAT_ARMOR_VERSION;

    const explosion = explosions.get(String(event.projectileId || ""));
    const impactPoint = Number.isFinite(Number(explosion?.x)) && Number.isFinite(Number(explosion?.y))
      ? {x: Number(explosion.x), y: Number(explosion.y)}
      : Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))
        ? {x: Number(event.x), y: Number(event.y)}
        : {x: Number(boat.x) || 0, y: Number(boat.y) || 0};
    queueExternalVesselImpact(world, {
      kind: "mega-bomb",
      boatId: boat.id,
      baseline: state.baseline,
      event,
      projectileId: event.projectileId,
      armorDamage,
      hullDamage,
      leak: leakIncrease,
      flooding: floodingIncrease,
      impactPoint,
      blastRadius: Math.max(12, Number(explosion?.radius) || 38),
    });

    if (state.armorMax > 0) {
      event.text = `Мега-бомба ударила по бронекатеру. Броня ${Math.round(state.armor)} из ${Math.round(state.armorMax)}, корпус ${Math.round(state.hull)} из ${Math.round(state.hullMax)}.`;
    }
  }

  // The old implementation hard-clamped every player boat to 100 hull. The
  // state above is now authoritative, so refresh aggregate disabled counts too.
  for (const explosion of explosions.values()) {
    const projectileId = String(explosion.projectileId || "");
    const related = hitEvents.filter(event => String(event.projectileId || "") === projectileId);
    explosion.disabledBoatCount = related.filter(event => {
      const state = states.get(String(event.boatId));
      return state && state.hull <= 0;
    }).length;
  }
}

export function launchMegaBomb(world, playerIndex) {
  const eventStart = values(world?.events).length;
  const launched = base.launchMegaBomb(world, playerIndex);
  normalizeFreshSpatial(world, eventStart);
  return launched;
}

export function launchPendingEliteBossBombs(world) {
  const eventStart = values(world?.events).length;
  const launched = base.launchPendingEliteBossBombs(world);
  normalizeFreshSpatial(world, eventStart);
  return launched;
}

export function stepMegaBombs(world, dt) {
  const states = boatSnapshots(world);
  const eventStart = values(world?.events).length;
  base.stepMegaBombs(world, dt);
  rebalancePlayerBoatBombHits(world, eventStart, states);
  runVesselSystems("external-impact", {world, dt: 0, eventStart});
  normalizeFreshSpatial(world, eventStart);
}
