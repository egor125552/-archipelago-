"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stateTransmission(connection, state) {
  if (state === "open" || state === "destroyed") return connection.acousticTransmission.open;
  return connection.acousticTransmission.closed;
}

function bestTransmission(runtime, fromSpaceId, toSpaceId) {
  if (fromSpaceId === toSpaceId) return {transmission: 1, path: []};
  const best = new Map([[fromSpaceId, 1]]);
  const previous = new Map();
  const pending = new Set(runtime.location.spaces.map(space => space.id));

  while (pending.size) {
    let current = null;
    let currentValue = -1;
    for (const id of pending) {
      const value = best.get(id) ?? -1;
      if (value > currentValue) {
        current = id;
        currentValue = value;
      }
    }
    if (current == null || currentValue < 0) break;
    pending.delete(current);
    if (current === toSpaceId) break;
    for (const connection of runtime.location.connections) {
      let next = null;
      if (connection.from.spaceId === current) next = connection.to.spaceId;
      else if (connection.bidirectional && connection.to.spaceId === current) next = connection.from.spaceId;
      if (!next || !pending.has(next)) continue;
      const transmission = stateTransmission(connection, runtime.getConnectionState(connection.id));
      const candidate = currentValue * transmission;
      if (candidate > (best.get(next) ?? -1)) {
        best.set(next, candidate);
        previous.set(next, {spaceId: current, connectionId: connection.id});
      }
    }
  }

  if (!previous.has(toSpaceId)) return {transmission: 0, path: []};
  const path = [];
  let cursor = toSpaceId;
  while (cursor !== fromSpaceId) {
    const edge = previous.get(cursor);
    if (!edge) return {transmission: 0, path: []};
    path.push(edge.connectionId);
    cursor = edge.spaceId;
  }
  path.reverse();
  return {transmission: best.get(toSpaceId) || 0, path};
}

export function computeSpatialAcoustics(runtime, {sourceSpaceId, listenerSpaceId}) {
  const sourceSpace = runtime.location.spacesById.get(sourceSpaceId);
  const listenerSpace = runtime.location.spacesById.get(listenerSpaceId);
  if (!sourceSpace || !listenerSpace) throw new Error("acoustic source and listener spaces must exist");
  const route = bestTransmission(runtime, sourceSpaceId, listenerSpaceId);
  const gain = clamp(route.transmission * sourceSpace.acoustics.gain * listenerSpace.acoustics.gain, 0, 1);
  const lowpassHz = Math.max(120, Math.min(sourceSpace.acoustics.lowpassHz, listenerSpace.acoustics.lowpassHz, 20000 * Math.max(0.08, route.transmission)));
  const reverb = clamp(Math.max(sourceSpace.acoustics.reverb, listenerSpace.acoustics.reverb) + (1 - route.transmission) * 0.15, 0, 1);
  return Object.freeze({
    gain,
    lowpassHz,
    reverb,
    transmission: route.transmission,
    connectionPath: Object.freeze(route.path),
    sourceProfile: sourceSpace.acoustics.profile,
    listenerProfile: listenerSpace.acoustics.profile,
  });
}
