"use strict";

import {VesselContractError, cloneData} from "./vessel-contract.js";

export const VESSEL_NETWORK_VERSION = 2;
export const VESSEL_NETWORK_COMPATIBLE_FROM = 1;

function compactState(definition, boat) {
  const result = {};
  const fields = definition?.runtimeStateFields || [];
  for (const field of fields) {
    if (boat?.[field] !== undefined) result[field] = cloneData(boat[field]);
  }
  return result;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function compactModuleState(registry, vesselDefinition, moduleDefinition, instance) {
  const moduleType = registry.resolveModuleType(moduleDefinition.type);
  const current = instance?.modules?.[moduleDefinition.id] || {};
  const baseline = moduleType?.createState
    ? moduleType.createState(moduleDefinition.config || {}, {vesselType: vesselDefinition, module: moduleDefinition}) || {}
    : {};
  const fields = Array.isArray(moduleType?.networkStateFields)
    ? moduleType.networkStateFields
    : Object.keys(current);
  const changed = {};
  for (const field of fields) {
    if (!Object.hasOwn(current, field)) continue;
    if (Object.hasOwn(baseline, field) && sameValue(current[field], baseline[field])) continue;
    changed[field] = cloneData(current[field]);
  }
  return changed;
}

function compactModules(registry, definition, instance) {
  const result = {};
  for (const moduleDefinition of definition?.modules || []) {
    const changed = compactModuleState(registry, definition, moduleDefinition, instance);
    if (Object.keys(changed).length) result[moduleDefinition.id] = changed;
  }
  return result;
}

export function vesselNetworkMetadata() {
  return Object.freeze({version: VESSEL_NETWORK_VERSION, compatibleFrom: VESSEL_NETWORK_COMPATIBLE_FROM});
}

export function assertVesselNetworkCompatibility(remote) {
  const version = Math.floor(Number(remote?.version) || 0);
  const compatibleFrom = Math.floor(Number(remote?.compatibleFrom) || version);
  const local = VESSEL_NETWORK_VERSION;
  const localFrom = VESSEL_NETWORK_COMPATIBLE_FROM;
  const compatible = version >= localFrom && local >= compatibleFrom;
  if (!compatible) {
    throw new VesselContractError(`incompatible vessel network contract: local ${local}, remote ${version}`, {
      local: {version: local, compatibleFrom: localFrom},
      remote: {version, compatibleFrom},
    });
  }
  return true;
}

export function vesselNetworkSnapshot(world, registry, nativeEntries = []) {
  const vessels = [];
  for (const entry of nativeEntries) {
    const instance = entry?.instance;
    const boat = entry?.boat;
    if (!instance || !boat) continue;
    const definition = registry.resolveVesselType(instance.typeId);
    if (!definition?.capabilities?.replicates) continue;
    vessels.push({
      instanceId: instance.instanceId,
      typeId: instance.typeId,
      legacyBoatId: Number.isInteger(instance.legacyBoatId) ? instance.legacyBoatId : null,
      state: compactState(definition, boat),
      // Module definitions are static content already present on both peers.
      // Replicate only runtime fields that differ from each module type's
      // initial state. Fifty healthy propulsion modules therefore cost zero
      // per snapshot, while a damaged engine or spent weapon still appears.
      modules: compactModules(registry, definition, instance),
      occupants: cloneData(instance.occupants || {}),
      zones: cloneData(instance.zones || {}),
    });
  }
  return Object.freeze({
    contract: vesselNetworkMetadata(),
    vessels,
  });
}

export function diffVesselNetworkSnapshots(previous, next) {
  const before = new Map((previous?.vessels || []).map(vessel => [vessel.instanceId, vessel]));
  const changed = [];
  const removed = [];
  for (const vessel of next?.vessels || []) {
    const old = before.get(vessel.instanceId);
    if (!old || JSON.stringify(old) !== JSON.stringify(vessel)) changed.push(vessel);
    before.delete(vessel.instanceId);
  }
  for (const instanceId of before.keys()) removed.push(instanceId);
  return Object.freeze({contract: next?.contract || vesselNetworkMetadata(), changed, removed});
}
