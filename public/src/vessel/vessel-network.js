"use strict";

import {VesselContractError, cloneData} from "./vessel-contract.js";
import {vesselDeckNetworkState} from "./vessel-deck-runtime.js";

export const VESSEL_NETWORK_VERSION = 3;
export const VESSEL_NETWORK_COMPATIBLE_FROM = 1;

function compactState(definition, boat) {
  const result = {};
  for (const field of definition?.runtimeStateFields || []) if (boat?.[field] !== undefined) result[field] = cloneData(boat[field]);
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
  const baseline = moduleType?.createState ? moduleType.createState(moduleDefinition.config || {}, {vesselType: vesselDefinition, module: moduleDefinition}) || {} : {};
  const fields = Array.isArray(moduleType?.networkStateFields) ? moduleType.networkStateFields : Object.keys(current);
  const always = new Set(Array.isArray(moduleType?.networkAlwaysFields) ? moduleType.networkAlwaysFields : []);
  const changed = {};
  for (const field of fields) {
    if (!Object.hasOwn(current, field)) continue;
    if (!always.has(field) && Object.hasOwn(baseline, field) && sameValue(current[field], baseline[field])) continue;
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
  for (const [moduleId, installation] of Object.entries(instance?.installations || {})) {
    if ((definition?.modules || []).some(module => module.id === moduleId)) continue;
    result[moduleId] = {$installation: cloneData(installation), ...cloneData(instance?.modules?.[moduleId] || {})};
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
    const vessel = {
      instanceId: instance.instanceId,
      typeId: instance.typeId,
      legacyBoatId: Number.isInteger(instance.legacyBoatId) ? instance.legacyBoatId : null,
      state: compactState(definition, boat),
      modules: compactModules(registry, definition, instance),
      occupants: cloneData(instance.occupants || {}),
      zones: cloneData(instance.zones || {}),
    };
    if (definition.deckArchitecture?.enabled) vessel.interior = vesselDeckNetworkState(registry, definition, instance);
    vessels.push(vessel);
  }
  return Object.freeze({contract: vesselNetworkMetadata(), vessels});
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
