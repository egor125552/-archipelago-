"use strict";

import {assertSpatialId, cloneSpatialData, normalizeTransform, normalizeVec3} from "./spatial-contract.js";
import {distance3d, localToWorld, resolveSpaceWorldTransform, spaceContainsLocalPoint} from "./spatial-transform.js";

export const SPATIAL_SAVE_VERSION = 1;

function immutableCopy(value) {
  return Object.freeze(cloneSpatialData(value));
}

function asMapObject(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, cloneSpatialData(value)]));
}

function isPlayer(entity) {
  return entity?.kind === "player";
}

export class SpatialRuntimeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpatialRuntimeError";
    this.details = details;
  }
}

export class SpatialRuntime {
  constructor(compiledLocation, {clock = () => Date.now()} = {}) {
    if (!compiledLocation?.spacesById || !compiledLocation?.connectionsById) throw new TypeError("SpatialRuntime needs a compiled location");
    this.location = compiledLocation;
    this.clock = clock;
    this.revision = 0;
    this.entities = new Map();
    this.connectionStates = new Map(compiledLocation.connections.map(connection => [connection.id, connection.initialState]));
    this.dynamicTransforms = new Map();
    this.spaceActivity = new Map(compiledLocation.spaces.map(space => [space.id, "active"]));
    this.moduleInstances = new Map();
    this.disabledModules = new Map();
    this.diagnostics = [...compiledLocation.diagnostics];
    this.events = [];
    this.listeners = new Set();
    this.#startModules();
  }

  #commit(kind, payload = {}) {
    this.revision += 1;
    const event = Object.freeze({revision: this.revision, time: this.clock(), kind, ...cloneSpatialData(payload)});
    this.events.push(event);
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
    return event;
  }

  #diagnose(level, code, message, details = {}) {
    const entry = Object.freeze({level, code, message, locationId: this.location.id, ...cloneSpatialData(details)});
    this.diagnostics.push(entry);
    return entry;
  }

  #moduleContext(instance, type) {
    const permissions = new Set(type.permissions || []);
    const readFacade = Object.freeze({
      location: this.location,
      getConnectionState: id => this.getConnectionState(id),
      getEntity: id => this.getEntity(id),
      getWorldPosition: id => this.getEntityWorldPosition(id),
      getSpaceActivity: id => this.getSpaceActivity(id),
    });
    const context = {
      moduleId: instance.id,
      moduleType: instance.type,
      config: instance.config,
      read: readFacade,
      emit: (kind, payload) => this.#commit(kind, {moduleId: instance.id, payload}),
    };
    if (permissions.has("semantic-context")) context.describeEntityContext = entityId => this.describeEntityContext(entityId);
    if (permissions.has("replication")) context.buildInterestSnapshot = (viewerId, options) => this.buildInterestSnapshot(viewerId, options);
    if (permissions.has("lifecycle")) context.refreshActivity = options => this.refreshActivity(options);
    if (permissions.has("persistence")) {
      context.save = () => this.saveState();
      context.restore = snapshot => this.restoreState(snapshot);
    }
    return Object.freeze(context);
  }

  #startModules() {
    for (const plan of this.location.modulePlans) {
      const {instance, type, disabledReason} = plan;
      if (!type || disabledReason) {
        this.disabledModules.set(instance.id, disabledReason || "unavailable");
        continue;
      }
      try {
        const service = type.create ? type.create(this.#moduleContext(instance, type)) : Object.freeze({});
        this.moduleInstances.set(instance.id, service || Object.freeze({}));
      } catch (error) {
        if (!instance.optional) throw new SpatialRuntimeError(`required module ${instance.id} failed to start: ${error?.message || error}`, {moduleId: instance.id, moduleType: instance.type});
        this.disabledModules.set(instance.id, "startup-failed");
        this.#diagnose("warning", "spatial.module.optional-runtime-failure", `optional module ${instance.id} was isolated after startup failure: ${error?.message || error}`, {moduleId: instance.id, moduleType: instance.type});
      }
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDiagnostics() {
    return Object.freeze(this.diagnostics.map(entry => immutableCopy(entry)));
  }

  getModule(id) {
    return this.moduleInstances.get(id) || null;
  }

  getDisabledModuleReason(id) {
    return this.disabledModules.get(id) || null;
  }

  getConnectionState(id) {
    if (!this.location.connectionsById.has(id)) throw new SpatialRuntimeError(`unknown connection ${id}`, {connectionId: id});
    return this.connectionStates.get(id);
  }

  setConnectionState(id, state) {
    const connection = this.location.connectionsById.get(id);
    if (!connection) throw new SpatialRuntimeError(`unknown connection ${id}`, {connectionId: id});
    const next = assertSpatialId(state, `connection ${id} state`);
    if (!connection.states.includes(next)) throw new SpatialRuntimeError(`connection ${id} does not support state ${next}`, {connectionId: id, state: next});
    const previous = this.connectionStates.get(id);
    if (previous === next) return false;
    this.connectionStates.set(id, next);
    this.#commit("connection.state", {connectionId: id, previous, state: next});
    return true;
  }

  getSpaceActivity(spaceId) {
    if (!this.location.spacesById.has(spaceId)) throw new SpatialRuntimeError(`unknown space ${spaceId}`, {spaceId});
    return this.spaceActivity.get(spaceId) || "sleeping";
  }

  getSpaceWorldTransform(spaceId) {
    return resolveSpaceWorldTransform(this.location, spaceId, this.dynamicTransforms);
  }

  setSpaceTransform(spaceId, transform) {
    const space = this.location.spacesById.get(spaceId);
    if (!space) throw new SpatialRuntimeError(`unknown space ${spaceId}`, {spaceId});
    if (!space.moving) throw new SpatialRuntimeError(`space ${spaceId} is not declared moving`, {spaceId});
    const normalized = normalizeTransform(transform, `dynamic transform ${spaceId}`);
    this.dynamicTransforms.set(spaceId, normalized);
    this.#commit("space.transform", {spaceId, transform: normalized});
    return normalized;
  }

  #findAnchor(anchorId, expectedSpaceId = null) {
    const entry = this.location.anchorsById.get(anchorId);
    if (!entry) return null;
    if (expectedSpaceId && entry.spaceId !== expectedSpaceId) return null;
    return entry;
  }

  #resolveSpawn(spawnId) {
    const spawn = this.location.spawnsById.get(spawnId);
    if (!spawn) throw new SpatialRuntimeError(`unknown spawn ${spawnId}`, {spawnId});
    if (spawn.anchorId) {
      const entry = this.#findAnchor(spawn.anchorId, spawn.spaceId);
      if (!entry || !entry.anchor.safe) throw new SpatialRuntimeError(`spawn ${spawnId} has unavailable anchor ${spawn.anchorId}`, {spawnId});
      return {spaceId: spawn.spaceId, position: entry.anchor.position, mode: spawn.mode};
    }
    return {spaceId: spawn.spaceId, position: spawn.position, mode: spawn.mode};
  }

  spawnEntity({id, kind = "player", spawnId = this.location.spawns[0].id, data = {}, label = null} = {}) {
    const entityId = assertSpatialId(id, "entity id");
    if (this.entities.has(entityId)) throw new SpatialRuntimeError(`entity ${entityId} already exists`, {entityId});
    const spawn = this.#resolveSpawn(spawnId);
    const entity = {
      id: entityId,
      kind: assertSpatialId(kind, `entity ${entityId}.kind`),
      label: String(label || entityId),
      spaceId: spawn.spaceId,
      localPosition: cloneSpatialData(spawn.position),
      mode: spawn.mode,
      data: cloneSpatialData(data),
    };
    this.entities.set(entityId, entity);
    this.spaceActivity.set(spawn.spaceId, "active");
    this.#commit("entity.spawn", {entityId, spaceId: spawn.spaceId, position: entity.localPosition, kind: entity.kind});
    return this.getEntity(entityId);
  }

  placeEntity({id, kind = "actor", label = null, spaceId, position, mode = "foot", data = {}} = {}) {
    const entityId = assertSpatialId(id, "entity id");
    if (this.entities.has(entityId)) throw new SpatialRuntimeError(`entity ${entityId} already exists`, {entityId});
    const space = this.location.spacesById.get(spaceId);
    if (!space) throw new SpatialRuntimeError(`unknown space ${spaceId}`, {spaceId});
    const localPosition = normalizeVec3(position, `entity ${entityId}.position`);
    if (!spaceContainsLocalPoint(space, localPosition)) throw new SpatialRuntimeError(`entity ${entityId} position is outside space ${spaceId}`, {entityId, spaceId});
    this.entities.set(entityId, {id: entityId, kind: assertSpatialId(kind, `entity ${entityId}.kind`), label: String(label || entityId), spaceId, localPosition: cloneSpatialData(localPosition), mode: String(mode), data: cloneSpatialData(data)});
    this.#commit("entity.place", {entityId, spaceId, position: localPosition, kind});
    return this.getEntity(entityId);
  }

  respawnEntity(id, spawnId = this.location.spawns[0].id, {preserveData = true} = {}) {
    const entity = this.entities.get(id);
    if (!entity) throw new SpatialRuntimeError(`unknown entity ${id}`, {entityId: id});
    const spawn = this.#resolveSpawn(spawnId);
    const previous = {spaceId: entity.spaceId, localPosition: cloneSpatialData(entity.localPosition), mode: entity.mode};
    entity.spaceId = spawn.spaceId;
    entity.localPosition = cloneSpatialData(spawn.position);
    entity.mode = spawn.mode;
    if (!preserveData) entity.data = {};
    this.spaceActivity.set(spawn.spaceId, "active");
    this.#commit("entity.respawn", {entityId: id, spawnId, previous, spaceId: spawn.spaceId, position: spawn.position});
    return this.getEntity(id);
  }

  removeEntity(id) {
    if (!this.entities.has(id)) return false;
    this.entities.delete(id);
    this.#commit("entity.remove", {entityId: id});
    return true;
  }

  getEntity(id) {
    const entity = this.entities.get(id);
    return entity ? immutableCopy(entity) : null;
  }

  listEntities() {
    return Object.freeze([...this.entities.values()].map(immutableCopy));
  }

  getEntityWorldPosition(id) {
    const entity = this.entities.get(id);
    if (!entity) throw new SpatialRuntimeError(`unknown entity ${id}`, {entityId: id});
    return immutableCopy(localToWorld(this.location, entity.spaceId, entity.localPosition, this.dynamicTransforms));
  }

  moveEntity(id, position) {
    const entity = this.entities.get(id);
    if (!entity) throw new SpatialRuntimeError(`unknown entity ${id}`, {entityId: id});
    const space = this.location.spacesById.get(entity.spaceId);
    const next = normalizeVec3(position, `entity ${id}.position`);
    if (!spaceContainsLocalPoint(space, next)) throw new SpatialRuntimeError(`entity ${id} cannot move outside space ${space.id}`, {entityId: id, spaceId: space.id, position: next});
    const previous = cloneSpatialData(entity.localPosition);
    entity.localPosition = cloneSpatialData(next);
    this.#commit("entity.move", {entityId: id, spaceId: entity.spaceId, previous, position: next});
    return this.getEntity(id);
  }

  transitionEntity(id, connectionId) {
    const entity = this.entities.get(id);
    if (!entity) throw new SpatialRuntimeError(`unknown entity ${id}`, {entityId: id});
    const connection = this.location.connectionsById.get(connectionId);
    if (!connection) throw new SpatialRuntimeError(`unknown connection ${connectionId}`, {connectionId});
    const state = this.getConnectionState(connectionId);
    if (!connection.passableStates.includes(state)) throw new SpatialRuntimeError(`connection ${connectionId} is not passable in state ${state}`, {connectionId, state});

    let from;
    let to;
    if (entity.spaceId === connection.from.spaceId) {
      from = connection.from;
      to = connection.to;
    } else if (connection.bidirectional && entity.spaceId === connection.to.spaceId) {
      from = connection.to;
      to = connection.from;
    } else {
      throw new SpatialRuntimeError(`entity ${id} is not in a space connected by ${connectionId}`, {entityId: id, connectionId, spaceId: entity.spaceId});
    }

    const destinationSpace = this.location.spacesById.get(to.spaceId);
    let destination = to.position;
    if (!spaceContainsLocalPoint(destinationSpace, destination) && to.fallbackAnchorId) {
      const fallback = this.#findAnchor(to.fallbackAnchorId, to.spaceId);
      if (fallback?.anchor.safe) destination = fallback.anchor.position;
    }
    if (!spaceContainsLocalPoint(destinationSpace, destination)) {
      throw new SpatialRuntimeError(`connection ${connectionId} destination is unsafe`, {connectionId, spaceId: to.spaceId});
    }

    const previous = {spaceId: entity.spaceId, localPosition: cloneSpatialData(entity.localPosition), mode: entity.mode};
    try {
      entity.spaceId = to.spaceId;
      entity.localPosition = cloneSpatialData(destination);
      this.spaceActivity.set(to.spaceId, "active");
      this.#commit("entity.transition", {entityId: id, connectionId, fromSpaceId: from.spaceId, toSpaceId: to.spaceId, position: destination, traversal: connection.traversal});
    } catch (error) {
      entity.spaceId = previous.spaceId;
      entity.localPosition = previous.localPosition;
      entity.mode = previous.mode;
      throw error;
    }
    return this.getEntity(id);
  }

  describeEntityContext(entityId) {
    const entity = this.entities.get(entityId);
    if (!entity) throw new SpatialRuntimeError(`unknown entity ${entityId}`, {entityId});
    const space = this.location.spacesById.get(entity.spaceId);
    const world = this.getEntityWorldPosition(entityId);
    const landmarks = space.anchors
      .filter(anchor => anchor.navigation)
      .map(anchor => ({id: anchor.id, label: anchor.presentation.label, kind: anchor.kind, distance: distance3d(entity.localPosition, anchor.position)}))
      .sort((a, b) => a.distance - b.distance);
    const transitions = this.location.connections
      .filter(connection => connection.from.spaceId === space.id || (connection.bidirectional && connection.to.spaceId === space.id))
      .map(connection => {
        const otherSpaceId = connection.from.spaceId === space.id ? connection.to.spaceId : connection.from.spaceId;
        return {
          id: connection.id,
          label: connection.presentation.label,
          kind: connection.kind,
          state: this.getConnectionState(connection.id),
          available: connection.passableStates.includes(this.getConnectionState(connection.id)),
          destinationLabel: this.location.spacesById.get(otherSpaceId)?.presentation.label || otherSpaceId,
        };
      });
    return immutableCopy({
      location: {id: this.location.id, label: this.location.presentation.label},
      space: {id: space.id, label: space.presentation.label, description: space.presentation.description},
      elevation: world.z,
      landmarks,
      transitions,
    });
  }

  refreshActivity({forceWakeSpaceIds = []} = {}) {
    const players = [...this.entities.values()].filter(isPlayer);
    const forced = new Set(forceWakeSpaceIds);
    const playerSpaces = new Set(players.map(player => player.spaceId));
    for (const player of players) {
      let cursor = this.location.spacesById.get(player.spaceId);
      while (cursor?.parentSpaceId) {
        playerSpaces.add(cursor.parentSpaceId);
        cursor = this.location.spacesById.get(cursor.parentSpaceId);
      }
    }
    const adjacent = new Set();
    for (const connection of this.location.connections) {
      if (playerSpaces.has(connection.from.spaceId)) adjacent.add(connection.to.spaceId);
      if (connection.bidirectional && playerSpaces.has(connection.to.spaceId)) adjacent.add(connection.from.spaceId);
    }

    const playerPositions = players.map(player => this.getEntityWorldPosition(player.id));
    const changes = [];
    for (const space of this.location.spaces) {
      let next = "sleeping";
      if (!space.activity.sleepAllowed || forced.has(space.id) || playerSpaces.has(space.id)) next = "active";
      else if (adjacent.has(space.id)) next = "preloaded";
      else if (playerPositions.length) {
        const origin = resolveSpaceWorldTransform(this.location, space.id, this.dynamicTransforms).position;
        const nearest = Math.min(...playerPositions.map(position => distance3d(position, origin)));
        if (nearest <= space.activity.activeRadius) next = "active";
        else if (nearest <= space.activity.preloadRadius) next = "preloaded";
      }
      const previous = this.spaceActivity.get(space.id);
      if (previous !== next) {
        this.spaceActivity.set(space.id, next);
        changes.push({spaceId: space.id, previous, state: next});
        this.#commit(next === "sleeping" ? "space.sleep" : "space.wake", {spaceId: space.id, previous, state: next});
      }
    }
    return Object.freeze(changes.map(immutableCopy));
  }

  buildInterestSnapshot(viewerId, {includeAdjacent = true} = {}) {
    const viewer = this.entities.get(viewerId);
    if (!viewer) throw new SpatialRuntimeError(`unknown viewer ${viewerId}`, {viewerId});
    const spaces = new Set([viewer.spaceId]);
    let cursor = this.location.spacesById.get(viewer.spaceId);
    while (cursor?.parentSpaceId) {
      spaces.add(cursor.parentSpaceId);
      cursor = this.location.spacesById.get(cursor.parentSpaceId);
    }
    for (const space of this.location.spaces) if (space.parentSpaceId === viewer.spaceId) spaces.add(space.id);
    if (includeAdjacent) {
      for (const connection of this.location.connections) {
        if (connection.from.spaceId === viewer.spaceId) spaces.add(connection.to.spaceId);
        if (connection.bidirectional && connection.to.spaceId === viewer.spaceId) spaces.add(connection.from.spaceId);
      }
    }
    for (const space of this.location.spaces) if (this.getSpaceActivity(space.id) === "preloaded") spaces.add(space.id);

    const entities = [...this.entities.values()].filter(entity => spaces.has(entity.spaceId)).map(entity => ({
      id: entity.id,
      kind: entity.kind,
      label: entity.label,
      spaceId: entity.spaceId,
      localPosition: cloneSpatialData(entity.localPosition),
      mode: entity.mode,
    }));
    const connections = this.location.connections.filter(connection => spaces.has(connection.from.spaceId) || spaces.has(connection.to.spaceId)).map(connection => ({id: connection.id, state: this.getConnectionState(connection.id)}));
    const dynamicTransforms = Object.fromEntries([...this.dynamicTransforms.entries()].filter(([spaceId]) => spaces.has(spaceId)).map(([spaceId, transform]) => [spaceId, cloneSpatialData(transform)]));
    return immutableCopy({
      schemaVersion: 1,
      locationId: this.location.id,
      revision: this.revision,
      viewerId,
      spaces: [...spaces],
      entities,
      connections,
      dynamicTransforms,
      events: this.events.filter(event => event.revision > Math.max(0, this.revision - 32)),
    });
  }

  saveState() {
    const moduleState = {};
    for (const [id, service] of this.moduleInstances) {
      if (typeof service?.serialize === "function") moduleState[id] = cloneSpatialData(service.serialize());
    }
    return immutableCopy({
      saveVersion: SPATIAL_SAVE_VERSION,
      locationId: this.location.id,
      schemaVersion: this.location.schemaVersion,
      persistenceVersion: this.location.persistence.version,
      revision: this.revision,
      connectionStates: asMapObject(this.connectionStates),
      dynamicTransforms: asMapObject(this.dynamicTransforms),
      entities: [...this.entities.values()].map(cloneSpatialData),
      moduleState,
    });
  }

  #fallbackEntityState(rawEntity) {
    const spawn = this.#resolveSpawn(this.location.spawns[0].id);
    return {
      id: rawEntity.id,
      kind: rawEntity.kind || "actor",
      label: String(rawEntity.label || rawEntity.id),
      spaceId: spawn.spaceId,
      localPosition: cloneSpatialData(spawn.position),
      mode: rawEntity.mode || spawn.mode,
      data: cloneSpatialData(rawEntity.data || {}),
    };
  }

  restoreState(snapshot, {migrations = []} = {}) {
    let candidate = cloneSpatialData(snapshot);
    if (!candidate || typeof candidate !== "object") throw new SpatialRuntimeError("save snapshot must be an object");
    if (candidate.locationId !== this.location.id) throw new SpatialRuntimeError(`save belongs to ${candidate.locationId}, not ${this.location.id}`, {locationId: candidate.locationId});
    let version = Number(candidate.saveVersion || 0);
    while (version < SPATIAL_SAVE_VERSION) {
      const migration = migrations.find(entry => entry.from === version && entry.to === version + 1);
      if (!migration || typeof migration.run !== "function") throw new SpatialRuntimeError(`missing save migration ${version} to ${version + 1}`, {version});
      const migrated = migration.run(cloneSpatialData(candidate));
      candidate = cloneSpatialData(migrated);
      version = Number(candidate.saveVersion || 0);
    }
    if (version !== SPATIAL_SAVE_VERSION) throw new SpatialRuntimeError(`unsupported save version ${version}`, {version});

    const nextConnections = new Map();
    for (const connection of this.location.connections) {
      const saved = candidate.connectionStates?.[connection.id];
      nextConnections.set(connection.id, connection.states.includes(saved) ? saved : connection.initialState);
    }

    const nextTransforms = new Map();
    for (const [spaceId, value] of Object.entries(candidate.dynamicTransforms || {})) {
      const space = this.location.spacesById.get(spaceId);
      if (!space?.moving) continue;
      try { nextTransforms.set(spaceId, normalizeTransform(value, `saved transform ${spaceId}`)); } catch {}
    }

    const nextEntities = new Map();
    for (const raw of candidate.entities || []) {
      let id;
      try { id = assertSpatialId(raw?.id, "saved entity id"); } catch { continue; }
      if (nextEntities.has(id)) throw new SpatialRuntimeError(`duplicate saved entity ${id}`, {entityId: id});
      let restored = null;
      const space = this.location.spacesById.get(raw.spaceId);
      if (space) {
        try {
          const position = normalizeVec3(raw.localPosition, `saved entity ${id}.position`);
          if (spaceContainsLocalPoint(space, position)) {
            restored = {
              id,
              kind: assertSpatialId(raw.kind || "actor", `saved entity ${id}.kind`),
              label: String(raw.label || id),
              spaceId: space.id,
              localPosition: cloneSpatialData(position),
              mode: String(raw.mode || "foot"),
              data: cloneSpatialData(raw.data || {}),
            };
          }
        } catch {}
      }
      if (!restored) {
        restored = this.#fallbackEntityState({...raw, id});
        this.#diagnose("warning", "spatial.save.entity-recovered", `entity ${id} was restored at the safe fallback spawn`, {entityId: id, previousSpaceId: raw.spaceId || null});
      }
      nextEntities.set(id, restored);
    }

    const previous = {
      connectionStates: this.connectionStates,
      dynamicTransforms: this.dynamicTransforms,
      entities: this.entities,
      revision: this.revision,
    };
    try {
      this.connectionStates = nextConnections;
      this.dynamicTransforms = nextTransforms;
      this.entities = nextEntities;
      this.revision = Math.max(0, Number(candidate.revision) || 0);
      for (const [id, service] of this.moduleInstances) {
        if (typeof service?.restore === "function" && Object.hasOwn(candidate.moduleState || {}, id)) service.restore(cloneSpatialData(candidate.moduleState[id]));
      }
      this.#commit("world.restore", {entityCount: this.entities.size});
    } catch (error) {
      this.connectionStates = previous.connectionStates;
      this.dynamicTransforms = previous.dynamicTransforms;
      this.entities = previous.entities;
      this.revision = previous.revision;
      throw new SpatialRuntimeError(`restore failed transactionally: ${error?.message || error}`);
    }
    this.refreshActivity();
    return true;
  }
}

export function createSpatialRuntime(compiledLocation, options) {
  return new SpatialRuntime(compiledLocation, options);
}
