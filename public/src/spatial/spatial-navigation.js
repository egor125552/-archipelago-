"use strict";

function connectionPassable(connection, state) {
  return connection.passableStates.includes(state);
}

export function findSpatialRoute(runtime, {fromSpaceId, toSpaceId}) {
  const location = runtime.location;
  if (!location.spacesById.has(fromSpaceId)) throw new Error(`unknown route start space ${fromSpaceId}`);
  if (!location.spacesById.has(toSpaceId)) throw new Error(`unknown route target space ${toSpaceId}`);
  if (fromSpaceId === toSpaceId) return Object.freeze({spaces: Object.freeze([fromSpaceId]), steps: Object.freeze([]), cost: 0});

  const distances = new Map([[fromSpaceId, 0]]);
  const previous = new Map();
  const pending = new Set(location.spaces.map(space => space.id));

  while (pending.size) {
    let current = null;
    let currentDistance = Infinity;
    for (const id of pending) {
      const distance = distances.get(id) ?? Infinity;
      if (distance < currentDistance) {
        current = id;
        currentDistance = distance;
      }
    }
    if (current == null || currentDistance === Infinity) break;
    pending.delete(current);
    if (current === toSpaceId) break;

    for (const connection of location.connections) {
      const state = runtime.getConnectionState(connection.id);
      if (!connectionPassable(connection, state)) continue;
      let next = null;
      let direction = null;
      if (connection.from.spaceId === current) {
        next = connection.to.spaceId;
        direction = "forward";
      } else if (connection.bidirectional && connection.to.spaceId === current) {
        next = connection.from.spaceId;
        direction = "reverse";
      }
      if (!next || !pending.has(next)) continue;
      const candidate = currentDistance + Math.max(0.001, Number(connection.cost) || 1);
      if (candidate < (distances.get(next) ?? Infinity)) {
        distances.set(next, candidate);
        previous.set(next, {spaceId: current, connectionId: connection.id, direction});
      }
    }
  }

  if (!previous.has(toSpaceId)) return null;
  const steps = [];
  const spaces = [toSpaceId];
  let cursor = toSpaceId;
  while (cursor !== fromSpaceId) {
    const edge = previous.get(cursor);
    if (!edge) return null;
    const connection = location.connectionsById.get(edge.connectionId);
    steps.push(Object.freeze({
      connectionId: edge.connectionId,
      label: connection.label,
      kind: connection.kind,
      direction: edge.direction,
      fromSpaceId: edge.spaceId,
      toSpaceId: cursor,
    }));
    cursor = edge.spaceId;
    spaces.push(cursor);
  }
  steps.reverse();
  spaces.reverse();
  return Object.freeze({spaces: Object.freeze(spaces), steps: Object.freeze(steps), cost: distances.get(toSpaceId)});
}

export function describeRoute(runtime, route) {
  if (!route) return "Маршрут недоступен";
  if (!route.steps.length) return "Цель находится в текущем пространстве";
  return route.steps.map(step => {
    const destination = runtime.location.spacesById.get(step.toSpaceId);
    return `${step.label}: ${destination?.label || step.toSpaceId}`;
  }).join(". ");
}
