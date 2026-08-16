"use strict";

function addAncestors(read, spaceId, spaces) {
  let cursor = read.location.spacesById.get(spaceId);
  while (cursor?.parentSpaceId) {
    spaces.add(cursor.parentSpaceId);
    cursor = read.location.spacesById.get(cursor.parentSpaceId);
  }
}

function addDirectChildren(read, spaceId, spaces) {
  for (const space of read.location.spaces) if (space.parentSpaceId === spaceId) spaces.add(space.id);
}

export function collectSpatialInterestSpaceIds(read, viewerId, {includeAdjacent = true} = {}) {
  if (!read?.location?.spacesById || typeof read.getEntity !== "function") throw new TypeError("read facade must provide location and getEntity()");
  const viewer = read.getEntity(viewerId);
  if (!viewer) throw new Error(`unknown viewer ${viewerId}`);
  const spaces = new Set([viewer.spaceId]);
  addAncestors(read, viewer.spaceId, spaces);
  addDirectChildren(read, viewer.spaceId, spaces);

  if (includeAdjacent) {
    const seeds = new Set(spaces);
    for (const connection of read.location.connections) {
      if (seeds.has(connection.from.spaceId)) spaces.add(connection.to.spaceId);
      if (connection.bidirectional && seeds.has(connection.to.spaceId)) spaces.add(connection.from.spaceId);
    }
  }
  return Object.freeze(read.location.spaces.filter(space => spaces.has(space.id)).map(space => space.id));
}

function collectReferencedSpaceIds(read, value, output = new Set(), depth = 0) {
  if (value == null || depth > 5) return output;
  if (Array.isArray(value)) {
    for (const entry of value) collectReferencedSpaceIds(read, entry, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && (key === "spaceId" || key.endsWith("SpaceId")) && read.location.spacesById.has(entry)) output.add(entry);
    if (typeof entry === "string" && (key === "connectionId" || key.endsWith("ConnectionId"))) {
      const connection = read.location.connectionsById.get(entry);
      if (connection) {
        output.add(connection.from.spaceId);
        output.add(connection.to.spaceId);
      }
    }
    if (typeof entry === "string" && (key === "entityId" || key.endsWith("EntityId"))) {
      const entity = read.getEntity(entry);
      if (entity?.spaceId) output.add(entity.spaceId);
    }
    collectReferencedSpaceIds(read, entry, output, depth + 1);
  }
  return output;
}

function eventMatchesInterest(read, event, spaces) {
  const referenced = collectReferencedSpaceIds(read, event);
  if (!referenced.size) return true;
  for (const spaceId of referenced) if (spaces.has(spaceId)) return true;
  return false;
}

export function filterSpatialInterestSnapshot(read, snapshot, viewerId, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("snapshot must be an object");
  const interestSpaceIds = collectSpatialInterestSpaceIds(read, viewerId, options);
  const spaces = new Set(interestSpaceIds);
  const connections = (snapshot.connections || []).filter(entry => {
    const connection = read.location.connectionsById.get(entry.id);
    return Boolean(connection && spaces.has(connection.from.spaceId) && spaces.has(connection.to.spaceId));
  });
  const dynamicTransforms = Object.fromEntries(Object.entries(snapshot.dynamicTransforms || {}).filter(([spaceId]) => spaces.has(spaceId)));
  return Object.freeze({
    ...snapshot,
    viewerId,
    spaces: interestSpaceIds,
    entities: Object.freeze((snapshot.entities || []).filter(entity => spaces.has(entity.spaceId))),
    connections: Object.freeze(connections),
    dynamicTransforms: Object.freeze(dynamicTransforms),
    events: Object.freeze((snapshot.events || []).filter(event => eventMatchesInterest(read, event, spaces))),
  });
}
