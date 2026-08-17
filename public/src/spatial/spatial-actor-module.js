"use strict";

import {
  createSpatialActorState,
  normalizeSpatialActorConfig,
  spatialActorEntityId,
} from "./spatial-actor-contract.js";

export function createSpatialActorService(config = {}, {emit = () => {}} = {}) {
  const normalized = normalizeSpatialActorConfig(config);
  const defs = new Map(normalized.actors.map(value => [value.id, value]));
  const states = new Map(normalized.actors.map(value => [value.id, createSpatialActorState(value)]));

  function def(id) {
    const found = defs.get(id);
    if (!found) throw new Error(`unknown actor ${id}`);
    return found;
  }

  function get(id) {
    const definition = def(id);
    const state = states.get(id);
    return Object.freeze({...definition, ...state, entityId: spatialActorEntityId(id)});
  }

  return Object.freeze({
    get,
    list() { return Object.freeze([...defs.keys()].map(get)); },
    spawn(runtime, id) {
      const definition = def(id);
      const state = states.get(id);
      if (!state.alive) return get(id);
      const entityId = spatialActorEntityId(id);
      if (!runtime.getEntity(entityId)) {
        runtime.placeEntity({
          id: entityId,
          kind: "actor",
          label: definition.label,
          spaceId: definition.spaceId,
          position: definition.position,
          mode: "foot",
          data: {
            actorId: id,
            hostile: definition.hostile,
            actorKind: definition.kind,
            actorTags: definition.tags,
            ...definition.data,
          },
        });
      }
      state.spawned = true;
      emit("actor.spawn", {actorId: id, entityId, spaceId: definition.spaceId});
      return get(id);
    },
    despawn(runtime, id) {
      def(id);
      runtime.removeEntity(spatialActorEntityId(id));
      states.get(id).spawned = false;
      emit("actor.despawn", {actorId: id});
      return get(id);
    },
    damage(runtime, id, amount, {sourceId = null} = {}) {
      def(id);
      const state = states.get(id);
      if (!state.alive) return get(id);
      const damage = Math.max(0, Number(amount) || 0);
      state.health = Math.max(0, state.health - damage);
      emit("actor.damage", {actorId: id, damage, health: state.health, sourceId});
      if (state.health <= 0) {
        state.alive = false;
        state.spawned = false;
        runtime?.removeEntity?.(spatialActorEntityId(id));
        emit("actor.death", {actorId: id, sourceId});
      }
      return get(id);
    },
    serialize() {
      return Object.fromEntries([...states].map(([id, state]) => [id, {...state}]));
    },
    restore(snapshot = {}) {
      for (const [id, definition] of defs) {
        const raw = snapshot?.[id];
        if (!raw) continue;
        states.set(id, createSpatialActorState(definition, raw));
      }
    },
  });
}

export const SPATIAL_ACTORS_MODULE_TYPE = Object.freeze({
  id: "spatial.actors",
  validateConfig(config) { normalizeSpatialActorConfig(config || {}); },
  create(context) {
    return createSpatialActorService(context.config || {}, {emit: (kind, payload) => context.emit(kind, payload)});
  },
});
