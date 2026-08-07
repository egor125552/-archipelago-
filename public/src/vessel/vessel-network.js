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
      modules: cloneData(instance.modules || {}),
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
