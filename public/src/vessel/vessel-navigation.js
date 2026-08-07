"use strict";

import {legacyVesselViews} from "./vessel-legacy-adapter.js";
import {nativeVesselByInstanceId, nativeVesselForBoat, vesselRegistry} from "./vessel-runtime.js";

const LEGACY_PREFIX = "vessel:";
const INSTANCE_PREFIX = "vessel-id:";

function boatById(world, boatId) {
  return Number.isInteger(boatId) ? world?.boats?.[boatId] || null : null;
}

function viewForBoat(world, boat) {
  if (!boat) return null;
  const legacy = legacyVesselViews(world).find(view => view.legacyBoatId === boat.id);
  const native = nativeVesselForBoat(world, boat.id);
  const definition = native ? vesselRegistry().resolveVesselType(native.instance.typeId) : null;
  const navigationTarget = definition
    ? definition.capabilities.sonarTarget === true
    : legacy?.navigationTarget === true;
  return {
    boat,
    native,
    instanceId: native?.instance?.instanceId || null,
    label: definition?.presentation?.label || legacy?.label || String(boat.label || "судно"),
    navigationTarget,
  };
}

function policySets(world) {
  const policy = world?.vesselNavigation || {};
  const hidden = new Set([...(policy.hiddenTargets || []), ...(policy.hiddenInstanceIds || [])].map(String));
  const mission = new Set([...(policy.missionTargets || []), ...(policy.missionRequiredInstanceIds || [])].map(String));
  return {hidden, mission};
}

function stableTargetId(view) {
  return view?.instanceId
    ? `${INSTANCE_PREFIX}${encodeURIComponent(view.instanceId)}`
    : `${LEGACY_PREFIX}${Number(view?.boat?.id)}`;
}

function isMissionRequired(policy, view, targetId) {
  return policy.mission.has(targetId)
    || (view?.instanceId && policy.mission.has(view.instanceId))
    || policy.mission.has(String(view?.boat?.id));
}

function isHidden(policy, view, targetId) {
  return policy.hidden.has(targetId)
    || (view?.instanceId && policy.hidden.has(view.instanceId))
    || policy.hidden.has(String(view?.boat?.id));
}

export function vesselNavigationTargetId(identity) {
  if (Number.isInteger(identity)) return `${LEGACY_PREFIX}${identity}`;
  const instanceId = String(identity || "").trim();
  return instanceId ? `${INSTANCE_PREFIX}${encodeURIComponent(instanceId)}` : null;
}

export function parseVesselNavigationTargetId(value) {
  const text = String(value || "");
  if (text.startsWith(INSTANCE_PREFIX)) {
    try {
      const instanceId = decodeURIComponent(text.slice(INSTANCE_PREFIX.length));
      return instanceId ? {instanceId, boatId: null} : null;
    } catch (_) {
      return null;
    }
  }
  if (!text.startsWith(LEGACY_PREFIX)) return null;
  const id = Number(text.slice(LEGACY_PREFIX.length));
  return Number.isInteger(id) && id >= 0 ? {instanceId: null, boatId: id} : null;
}

export function listVesselNavigationTargets(world, playerIndex) {
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat)
    ? world.players[playerIndex].activeBoat
    : null;
  const policy = policySets(world);
  const targets = [];
  for (const boat of world?.boats || []) {
    if (!boat || boat.sunk || boat.reserved || boat.id === currentBoatId) continue;
    const view = viewForBoat(world, boat);
    if (!view?.navigationTarget) continue;
    const id = stableTargetId(view);
    const missionRequired = isMissionRequired(policy, view, id);
    if (isHidden(policy, view, id) && !missionRequired) continue;
    targets.push({
      id,
      instanceId: view.instanceId,
      boatId: boat.id,
      label: view.label,
      x: Number(boat.x) || 0,
      y: Number(boat.y) || 0,
      missionRequired,
    });
  }
  return targets;
}

export function vesselNavigationTargetFromId(world, playerIndex, navigationTargetId) {
  const parsed = parseVesselNavigationTargetId(navigationTargetId);
  if (!parsed) return null;
  const native = parsed.instanceId ? nativeVesselByInstanceId(world, parsed.instanceId) : null;
  const boatId = native?.boat?.id ?? parsed.boatId;
  const currentBoatId = Number.isInteger(world?.players?.[playerIndex]?.activeBoat)
    ? world.players[playerIndex].activeBoat
    : null;
  if (boatId == null || boatId === currentBoatId) return null;
  const boat = boatById(world, boatId);
  if (!boat || boat.sunk || boat.reserved) return null;
  const view = viewForBoat(world, boat);
  if (!view?.navigationTarget) return null;
  const id = stableTargetId(view);
  const policy = policySets(world);
  const missionRequired = isMissionRequired(policy, view, id);
  if (isHidden(policy, view, id) && !missionRequired) return null;
  return {
    id,
    kind: "vessel",
    instanceId: view.instanceId,
    boatId: boat.id,
    label: view.label,
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
    missionRequired,
  };
}
