"use strict";

import {VesselContractError, assertId} from "./vessel-contract.js";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

function damageAmount(hit) {
  const amount = Number(hit?.damage);
  if (!Number.isFinite(amount) || amount < 0) throw new VesselContractError("damage descriptor needs non-negative damage");
  return amount;
}

function globalDamage(boat, hit) {
  const amount = damageAmount(hit);
  const armor = Math.max(0, Number(boat.armor) || 0);
  const armorDamage = Math.min(armor, Math.max(0, Number(hit.armorDamage ?? amount) || 0));
  boat.armor = Math.max(0, armor - armorDamage);
  const penetration = clamp(Number(hit.penetration ?? 1), 0, 1);
  const absorbed = amount > 0 ? clamp(armorDamage / amount, 0, 1) : 0;
  const hullDamage = amount * Math.max(0, 1 - absorbed) * penetration;
  boat.hull = Math.max(0, (Number(boat.hull) || 0) - hullDamage);
  if (Number.isFinite(Number(hit.leak))) boat.leak = Math.max(0, (Number(boat.leak) || 0) + Number(hit.leak));
  return Object.freeze({mode: "global", armorDamage, hullDamage, hull: boat.hull, armor: boat.armor});
}

export function applyVesselDamage(definition, runtime, boat, hit = {}) {
  if (!definition?.capabilities?.damageable) return Object.freeze({mode: "ignored", reason: "not-damageable"});
  if (definition.capabilities.zonalDamage !== true || definition.damage?.mode !== "zonal") {
    return globalDamage(boat, hit);
  }

  const amount = damageAmount(hit);
  const zoneId = hit.zoneId == null ? null : assertId(hit.zoneId, "damage zoneId");
  const moduleId = hit.moduleId == null ? null : assertId(hit.moduleId, "damage moduleId");
  const zone = zoneId
    ? (definition.decks || []).flatMap(deck => deck.zones).find(candidate => candidate.id === zoneId)
    : null;
  if (zoneId && !zone) throw new VesselContractError(`damage references unknown zone ${zoneId}`);
  if (moduleId && !runtime?.modules?.[moduleId]) throw new VesselContractError(`damage references unknown module ${moduleId}`);

  runtime.zones ||= {};
  if (zone) {
    const current = runtime.zones[zone.id] || {health: 100, flooding: 0, fire: 0};
    current.health = clamp((Number(current.health) || 0) - amount, 0, 100);
    current.flooding = clamp((Number(current.flooding) || 0) + Math.max(0, Number(hit.flooding) || 0), 0, 100);
    current.fire = clamp((Number(current.fire) || 0) + Math.max(0, Number(hit.fire) || 0), 0, 100);
    runtime.zones[zone.id] = current;
  }
  if (moduleId) {
    const moduleState = runtime.modules[moduleId];
    moduleState.health = clamp((Number(moduleState.health) || 100) - amount, 0, 100);
    if (moduleState.health <= 0) moduleState.enabled = false;
  }

  const hullShare = clamp(Number(definition.damage?.hullShare ?? 0.25), 0, 1);
  const hullDamage = amount * hullShare;
  boat.hull = Math.max(0, (Number(boat.hull) || 0) - hullDamage);
  if (Number.isFinite(Number(hit.leak))) boat.leak = Math.max(0, (Number(boat.leak) || 0) + Number(hit.leak));
  return Object.freeze({
    mode: "zonal",
    zoneId,
    moduleId,
    hullDamage,
    hull: boat.hull,
    zone: zoneId ? {...runtime.zones[zoneId]} : null,
    module: moduleId ? {...runtime.modules[moduleId]} : null,
  });
}
