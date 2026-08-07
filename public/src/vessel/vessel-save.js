"use strict";

import {VesselContractError, cloneData} from "./vessel-contract.js";

export const VESSEL_SAVE_VERSION = 2;

export class VesselMigrationError extends VesselContractError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "VesselMigrationError";
    this.recoverable = true;
  }
}

function safeTypeId(boat) {
  const raw = String(boat?.vesselType || boat?.boatType || boat?.type || "standard").toLowerCase();
  const clean = raw.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "standard";
}

function ensureArchitecture(world) {
  const current = world.vesselArchitecture && typeof world.vesselArchitecture === "object"
    ? world.vesselArchitecture
    : {};
  const nextSequence = Math.max(1, Math.floor(Number(current.nextInstanceSequence) || 1));
  world.vesselArchitecture = {...current, saveVersion: Math.max(0, Math.floor(Number(current.saveVersion) || 0)), nextInstanceSequence: nextSequence};
  return world.vesselArchitecture;
}

function allocateMigrationInstanceId(world, typeId) {
  const architecture = ensureArchitecture(world);
  const sequence = architecture.nextInstanceSequence++;
  return `legacy:${typeId}:i${sequence}`;
}

function migrate0To1(world) {
  const architecture = ensureArchitecture(world);
  const seen = new Set();
  for (const boat of world.boats || []) {
    if (!boat || typeof boat !== "object") continue;
    const typeId = safeTypeId(boat);
    boat.vesselType = typeId;
    let instanceId = String(boat.vesselInstanceId || "").trim();
    if (!instanceId || seen.has(instanceId)) instanceId = allocateMigrationInstanceId(world, typeId);
    boat.vesselInstanceId = instanceId;
    seen.add(instanceId);
  }
  architecture.saveVersion = 1;
  return world;
}

function migrate1To2(world) {
  const architecture = ensureArchitecture(world);
  architecture.contractVersion = 2;
  architecture.saveVersion = 2;
  return world;
}

const MIGRATIONS = new Map([[0, migrate0To1], [1, migrate1To2]]);

export function validatePersistedVesselWorld(world) {
  if (!world || typeof world !== "object") throw new VesselMigrationError("saved world must be an object");
  const architecture = ensureArchitecture(world);
  if (architecture.saveVersion !== VESSEL_SAVE_VERSION) {
    throw new VesselMigrationError(`unsupported vessel save version ${architecture.saveVersion}`);
  }
  const ids = new Set();
  for (const boat of world.boats || []) {
    if (!boat) continue;
    const instanceId = String(boat.vesselInstanceId || "").trim();
    if (!instanceId) throw new VesselMigrationError("saved vessel is missing vesselInstanceId");
    if (ids.has(instanceId)) throw new VesselMigrationError(`duplicate vessel instanceId ${instanceId}`);
    ids.add(instanceId);
    if (!String(boat.vesselType || "").trim()) throw new VesselMigrationError(`saved vessel ${instanceId} is missing vesselType`);
  }
  return world;
}

export function migratePersistedVesselWorld(input) {
  // Transactional by construction: all migration work happens on a clone.
  // Callers only replace their saved/runtime value after this function returns successfully.
  const working = cloneData(input);
  try {
    const architecture = ensureArchitecture(working);
    if (architecture.saveVersion > VESSEL_SAVE_VERSION) {
      throw new VesselMigrationError(`saved vessel version ${architecture.saveVersion} is newer than this build`);
    }
    while (architecture.saveVersion < VESSEL_SAVE_VERSION) {
      const migration = MIGRATIONS.get(architecture.saveVersion);
      if (!migration) throw new VesselMigrationError(`missing vessel migration from version ${architecture.saveVersion}`);
      migration(working);
    }
    return validatePersistedVesselWorld(working);
  } catch (error) {
    if (error instanceof VesselMigrationError) throw error;
    throw new VesselMigrationError(`vessel migration failed: ${error?.message || error}`, {cause: error});
  }
}

export function vesselSaveMetadata(world) {
  const architecture = ensureArchitecture(world);
  return Object.freeze({saveVersion: architecture.saveVersion, contractVersion: architecture.contractVersion || 2});
}
