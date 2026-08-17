"use strict";

export const SPATIAL_ACTOR_SCHEMA_VERSION = 1;

function requiredId(value, field) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function finite(value, field, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return number;
}

export function normalizeSpatialActorPosition(value = {}, field = "actor.position") {
  const position = Object.freeze({
    x: finite(value.x ?? value[0], `${field}.x`, 0),
    y: finite(value.y ?? value[1], `${field}.y`, 0),
    z: finite(value.z ?? value[2], `${field}.z`, 0),
  });
  return position;
}

export function normalizeSpatialActorDefinition(raw, {index = 0} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`actors[${index}] must be an object`);
  }
  const id = requiredId(raw.id, `actors[${index}].id`);
  const spaceId = requiredId(raw.spaceId, `${id}.spaceId`);
  const maxHealth = Math.max(1, finite(raw.maxHealth, `${id}.maxHealth`, 100));
  return Object.freeze({
    schemaVersion: SPATIAL_ACTOR_SCHEMA_VERSION,
    id,
    label: String(raw.label || id),
    kind: String(raw.kind || "npc"),
    spaceId,
    position: normalizeSpatialActorPosition(raw.position || {}, `${id}.position`),
    maxHealth,
    hostile: raw.hostile === true,
    tags: Object.freeze([...(raw.tags || [])].map(value => String(value))),
    data: Object.freeze({...raw.data}),
  });
}

export function normalizeSpatialActorConfig(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("actors config must be an object");
  }
  const actors = (config.actors || []).map((raw, index) => normalizeSpatialActorDefinition(raw, {index}));
  const ids = new Set();
  for (const actor of actors) {
    if (ids.has(actor.id)) throw new Error(`duplicate actor id ${actor.id}`);
    ids.add(actor.id);
  }
  return Object.freeze({schemaVersion: SPATIAL_ACTOR_SCHEMA_VERSION, actors: Object.freeze(actors)});
}

export function spatialActorEntityId(actorId) {
  return `actor.${requiredId(actorId, "actorId")}`;
}

export function createSpatialActorState(definition, snapshot = null) {
  const health = snapshot == null
    ? definition.maxHealth
    : Math.max(0, Math.min(definition.maxHealth, finite(snapshot.health, `${definition.id}.health`, definition.maxHealth)));
  return {
    health,
    alive: snapshot?.alive !== false && health > 0,
    sleeping: snapshot?.sleeping === true && health > 0,
    spawned: snapshot?.sleeping === true ? false : Boolean(snapshot?.spawned),
  };
}
