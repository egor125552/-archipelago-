"use strict";

import {assertSpatialId, cloneSpatialData} from "./spatial-contract.js";
import {compileSpatialLocation, createSpatialModuleRegistry} from "./spatial-compiler.js";
import {createSpatialRuntime} from "./spatial-runtime.js";

export class SpatialWorldError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpatialWorldError";
    this.details = details;
  }
}

export class SpatialWorld {
  constructor({moduleRegistry = createSpatialModuleRegistry(), mode = "development", clock = () => Date.now()} = {}) {
    this.moduleRegistry = moduleRegistry;
    this.mode = mode;
    this.clock = clock;
    this.locations = new Map();
    this.disabledLocations = new Map();
    this.links = new Map();
    this.diagnostics = [];
    this.events = [];
    this.revision = 0;
    this.transactionEvents = null;
  }

  #event(kind, payload = {}) {
    this.revision += 1;
    const event = Object.freeze({revision: this.revision, time: this.clock(), kind, ...cloneSpatialData(payload)});
    if (this.transactionEvents) {
      this.transactionEvents.push(event);
      return event;
    }
    this.#publishEvent(event);
    return event;
  }

  #publishEvent(event) {
    this.events.push(event);
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  #flushTransactionEvents(events) {
    for (const event of events || []) this.#publishEvent(event);
  }

  addLocation(definition, {optional = false} = {}) {
    const proposedId = String(definition?.id || "unknown.location");
    if (this.locations.has(proposedId)) throw new SpatialWorldError(`location ${proposedId} is already registered`, {locationId: proposedId});
    try {
      const compiled = compileSpatialLocation(definition, {moduleRegistry: this.moduleRegistry, mode: this.mode});
      const runtime = createSpatialRuntime(compiled, {clock: this.clock});
      const unsubscribe = runtime.subscribe(event => this.#event("location.event", {locationId: compiled.id, event}));
      this.locations.set(compiled.id, {compiled, runtime, unsubscribe});
      this.disabledLocations.delete(compiled.id);
      this.#event("location.add", {locationId: compiled.id});
      return runtime;
    } catch (error) {
      if (!optional || this.mode === "development") throw error;
      const entry = Object.freeze({
        level: "warning",
        code: "spatial.location.optional-disabled",
        locationId: proposedId,
        message: `optional location ${proposedId} was isolated: ${error?.message || error}`,
      });
      this.disabledLocations.set(proposedId, entry);
      this.diagnostics.push(entry);
      this.#event("location.disabled", {locationId: proposedId, reason: entry.message});
      return null;
    }
  }

  removeLocation(locationId) {
    const entry = this.locations.get(locationId);
    if (!entry) return false;
    const occupied = entry.runtime.listEntities();
    if (occupied.length) throw new SpatialWorldError(`cannot remove occupied location ${locationId}`, {locationId, entityIds: occupied.map(entity => entity.id)});
    entry.unsubscribe?.();
    this.locations.delete(locationId);
    for (const [id, link] of this.links) if (link.from.locationId === locationId || link.to.locationId === locationId) this.links.delete(id);
    this.#event("location.remove", {locationId});
    return true;
  }

  getLocationRuntime(locationId) {
    return this.locations.get(locationId)?.runtime || null;
  }

  listLocations() {
    return Object.freeze([...this.locations.keys()]);
  }

  registerLink(definition) {
    const id = assertSpatialId(definition?.id, "world link id");
    if (this.links.has(id)) throw new SpatialWorldError(`duplicate world link ${id}`, {linkId: id});
    const fromLocationId = assertSpatialId(definition?.from?.locationId, `world link ${id}.from.locationId`);
    const toLocationId = assertSpatialId(definition?.to?.locationId, `world link ${id}.to.locationId`);
    const fromSpawnId = assertSpatialId(definition?.from?.spawnId, `world link ${id}.from.spawnId`);
    const toSpawnId = assertSpatialId(definition?.to?.spawnId, `world link ${id}.to.spawnId`);
    if (!this.locations.has(fromLocationId) || !this.locations.has(toLocationId)) throw new SpatialWorldError(`world link ${id} references unavailable location`, {linkId: id});
    if (!this.locations.get(fromLocationId).compiled.spawnsById.has(fromSpawnId) || !this.locations.get(toLocationId).compiled.spawnsById.has(toSpawnId)) throw new SpatialWorldError(`world link ${id} references unavailable spawn`, {linkId: id});
    const link = Object.freeze({id, bidirectional: definition.bidirectional !== false, from: Object.freeze({locationId: fromLocationId, spawnId: fromSpawnId}), to: Object.freeze({locationId: toLocationId, spawnId: toSpawnId})});
    this.links.set(id, link);
    this.#event("world-link.add", {linkId: id});
    return link;
  }

  findEntity(entityId) {
    let found = null;
    for (const [locationId, entry] of this.locations) {
      const entity = entry.runtime.getEntity(entityId);
      if (!entity) continue;
      if (found) throw new SpatialWorldError(`entity ${entityId} exists in more than one location`, {entityId});
      found = {locationId, runtime: entry.runtime, entity};
    }
    return found;
  }

  spawnEntity(locationId, options) {
    const runtime = this.getLocationRuntime(locationId);
    if (!runtime) throw new SpatialWorldError(`location ${locationId} is unavailable`, {locationId});
    if (this.findEntity(options?.id)) throw new SpatialWorldError(`entity ${options.id} already exists in the world`, {entityId: options.id});
    const entity = runtime.spawnEntity(options);
    this.#event("entity.spawn", {locationId, entityId: entity.id});
    return entity;
  }

  transferEntity(entityId, {toLocationId, spawnId}) {
    const source = this.findEntity(entityId);
    if (!source) throw new SpatialWorldError(`unknown entity ${entityId}`, {entityId});
    const target = this.getLocationRuntime(toLocationId);
    if (!target) throw new SpatialWorldError(`target location ${toLocationId} is unavailable`, {toLocationId});
    if (source.locationId === toLocationId) return source.runtime.respawnEntity(entityId, spawnId);

    const old = source.entity;
    let placed = null;
    try {
      placed = target.spawnEntity({id: old.id, kind: old.kind, label: old.label, spawnId, data: old.data});
    } catch (error) {
      throw new SpatialWorldError(`transfer of ${entityId} failed before source removal: ${error?.message || error}`, {entityId, fromLocationId: source.locationId, toLocationId});
    }
    try {
      source.runtime.removeEntity(entityId);
    } catch (error) {
      target.removeEntity(entityId);
      throw new SpatialWorldError(`transfer of ${entityId} rolled back: ${error?.message || error}`, {entityId});
    }
    this.#event("entity.transfer", {entityId, fromLocationId: source.locationId, toLocationId, spawnId});
    return placed;
  }

  useLink(entityId, linkId) {
    const link = this.links.get(linkId);
    if (!link) throw new SpatialWorldError(`unknown world link ${linkId}`, {linkId});
    const source = this.findEntity(entityId);
    if (!source) throw new SpatialWorldError(`unknown entity ${entityId}`, {entityId});
    if (source.locationId === link.from.locationId) return this.transferEntity(entityId, {toLocationId: link.to.locationId, spawnId: link.to.spawnId});
    if (link.bidirectional && source.locationId === link.to.locationId) return this.transferEntity(entityId, {toLocationId: link.from.locationId, spawnId: link.from.spawnId});
    throw new SpatialWorldError(`entity ${entityId} is not on a location connected by ${linkId}`, {entityId, linkId, locationId: source.locationId});
  }

  buildViewerSnapshot(entityId) {
    const found = this.findEntity(entityId);
    if (!found) throw new SpatialWorldError(`unknown viewer ${entityId}`, {entityId});
    const local = found.runtime.buildInterestSnapshot(entityId);
    return Object.freeze({worldRevision: this.revision, currentLocationId: found.locationId, local});
  }

  saveWorld() {
    return Object.freeze({
      worldSaveVersion: 1,
      revision: this.revision,
      locations: Object.fromEntries([...this.locations].map(([id, entry]) => [id, entry.runtime.saveState()])),
    });
  }

  restoreWorld(snapshot, {restoreOptionsByLocation = {}} = {}) {
    if (this.transactionEvents) throw new SpatialWorldError("nested world restore transactions are not supported");
    if (!snapshot || Number(snapshot.worldSaveVersion) !== 1) throw new SpatialWorldError("unsupported world save");
    const previousRevision = this.revision;
    const transactions = [];
    this.transactionEvents = [];
    try {
      for (const [id, state] of Object.entries(snapshot.locations || {})) {
        const runtime = this.getLocationRuntime(id);
        if (!runtime) continue;
        const transaction = runtime.beginRestoreTransaction(state, restoreOptionsByLocation[id] || {});
        transactions.push({id, transaction});
      }
      for (const {transaction} of transactions) transaction.commit();
      this.#event("world.restore", {locationCount: this.locations.size});
      const committedEvents = this.transactionEvents;
      this.transactionEvents = null;
      this.#flushTransactionEvents(committedEvents);
    } catch (error) {
      const rollbackErrors = [];
      for (const {id, transaction} of [...transactions].reverse()) {
        try {
          for (const rollbackError of transaction.rollback()) rollbackErrors.push(`${id}: ${rollbackError}`);
        } catch (rollbackError) {
          rollbackErrors.push(`${id}: ${rollbackError?.message || rollbackError}`);
        }
      }
      this.revision = previousRevision;
      this.transactionEvents = null;
      throw new SpatialWorldError(`world restore rolled back: ${error?.message || error}`, {
        cause: error?.message || String(error),
        rollbackErrors,
      });
    }
    return true;
  }
  getDiagnostics() {
    const locationDiagnostics = [...this.locations].flatMap(([locationId, entry]) => entry.runtime.getDiagnostics().map(item => ({...item, locationId})));
    return Object.freeze([...this.diagnostics, ...locationDiagnostics].map(entry => Object.freeze(cloneSpatialData(entry))));
  }
}
