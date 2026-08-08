"use strict";

import {VesselContractError, assertId, cloneData} from "./vessel-contract.js";

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

function installationFor(registry, definition, runtime, request) {
  const id = assertId(request?.id, "module instance id");
  const type = assertId(request?.type, `module type for ${id}`);
  const moduleType = registry.resolveModuleType(type);
  if (!moduleType) throw new VesselContractError(`unregistered module type ${type}`);
  const mounts = [...(request?.mounts || [])].map(mountId => assertId(mountId, `module ${id} mount`));
  if (mounts.length !== moduleType.installation.mountCount) throw new VesselContractError(`module ${id} needs exactly ${moduleType.installation.mountCount} mounts`);
  if (new Set(mounts).size !== mounts.length) throw new VesselContractError(`module ${id} cannot occupy the same mount twice`);
  const mountById = new Map((definition.mounts || []).map(mount => [mount.id, mount]));
  for (const mountId of mounts) {
    const mount = mountById.get(mountId);
    if (!mount) throw new VesselContractError(`module ${id} references missing mount ${mountId}`);
    const occupied = runtime.mountOccupancy?.[mountId];
    if (occupied && occupied !== id) throw new VesselContractError(`mount ${mountId} is already occupied by ${occupied}`);
    const compatible = moduleType.installation.mountKinds.includes(mount.kind) || mount.accepts.includes(type);
    if (!compatible) throw new VesselContractError(`module ${id} is incompatible with mount ${mountId}`);
  }
  const config = cloneData(request?.config || {});
  moduleType.validateConfig?.(config, {vesselTypeId: definition.id, moduleInstanceId: id});
  return {id, type, mounts, config, moduleType};
}

export function planModuleInstallation(registry, definition, runtime, request) {
  if (!runtime || !definition) throw new VesselContractError("module installation needs vessel definition and runtime");
  if (runtime.installations?.[request?.id]) throw new VesselContractError(`module ${request.id} is already installed`);
  const plan = installationFor(registry, definition, runtime, request);
  return Object.freeze({id: plan.id, type: plan.type, mounts: Object.freeze([...plan.mounts]), config: Object.freeze(cloneData(plan.config))});
}

export function installVesselModule(registry, definition, runtime, request) {
  const plan = planModuleInstallation(registry, definition, runtime, request);
  const moduleType = registry.resolveModuleType(plan.type);
  const initial = moduleType?.createState ? moduleType.createState(plan.config, {vesselType: definition, module: plan}) : {};
  const nextState = {...cloneData(initial), ...cloneData(request?.state || {})};
  runtime.modules ||= {};
  runtime.installations ||= {};
  runtime.mountOccupancy ||= {};
  runtime.modules[plan.id] = nextState;
  runtime.installations[plan.id] = {type: plan.type, mounts: [...plan.mounts], config: cloneData(plan.config)};
  for (const mountId of plan.mounts) runtime.mountOccupancy[mountId] = plan.id;
  return runtime.installations[plan.id];
}

export function uninstallVesselModule(runtime, moduleInstanceId) {
  const id = assertId(moduleInstanceId, "module instance id");
  const installation = runtime?.installations?.[id];
  if (!installation) return false;
  for (const mountId of installation.mounts || []) if (runtime.mountOccupancy?.[mountId] === id) delete runtime.mountOccupancy[mountId];
  delete runtime.installations[id];
  if (runtime.modules) delete runtime.modules[id];
  return true;
}

export function vesselModuleEffectiveness(registry, definition, runtime, moduleInstanceId) {
  const id = assertId(moduleInstanceId, "module instance id");
  const installation = runtime?.installations?.[id];
  const state = runtime?.modules?.[id];
  if (!installation || !state || state.enabled === false) return 0;
  const health = Number(state.health);
  if (Number.isFinite(health) && health <= 0) return 0;
  const moduleType = registry.resolveModuleType(installation.type);
  if (moduleType?.effectiveness) {
    return clamp01(moduleType.effectiveness({definition, runtime, moduleId: id, installation, config: installation.config || {}, state}));
  }
  return 1;
}
