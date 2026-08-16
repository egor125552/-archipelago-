"use strict";

import {distance3d} from "./spatial-transform.js";

function connectionPassable(connection, state) {
  return connection.passableStates.includes(state);
}

function movementAllowed(linePassable, spaceId, from, to) {
  return typeof linePassable !== "function" || linePassable(spaceId, from, to) !== false;
}

function addEdge(graph, fromId, toId, cost, metadata) {
  graph.get(fromId).push({to: toId, cost: Math.max(0.001, Number(cost) || 0.001), ...metadata});
}

function addWalkEdges(nodes, graph, linePassable) {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (left.spaceId !== right.spaceId) continue;
      if (!left.point || !right.point) {
        addEdge(graph, left.id, right.id, 0.001, {kind: "walk", spaceId: left.spaceId});
        addEdge(graph, right.id, left.id, 0.001, {kind: "walk", spaceId: left.spaceId});
        continue;
      }
      if (!movementAllowed(linePassable, left.spaceId, left.point, right.point)) continue;
      const cost = distance3d(left.point, right.point);
      addEdge(graph, left.id, right.id, cost, {kind: "walk", spaceId: left.spaceId});
      addEdge(graph, right.id, left.id, cost, {kind: "walk", spaceId: left.spaceId});
    }
  }
}

function reconstructRoute(runtime, nodesById, previous, distances, startId, goalId, fromSpaceId) {
  if (goalId !== startId && !previous.has(goalId)) return null;
  const traversed = [];
  let cursor = goalId;
  while (cursor !== startId) {
    const entry = previous.get(cursor);
    if (!entry) return null;
    traversed.push({from: entry.from, to: cursor, edge: entry.edge});
    cursor = entry.from;
  }
  traversed.reverse();

  const spaces = [fromSpaceId];
  const steps = [];
  const waypoints = [];
  for (const part of traversed) {
    const destinationNode = nodesById.get(part.to);
    if (destinationNode?.point) {
      waypoints.push(Object.freeze({
        spaceId: destinationNode.spaceId,
        point: Object.freeze({...destinationNode.point}),
        kind: destinationNode.kind || "waypoint",
      }));
    }
    if (part.edge.kind !== "connection") continue;
    const connection = runtime.location.connectionsById.get(part.edge.connectionId);
    const from = part.edge.direction === "forward" ? connection.from : connection.to;
    const to = part.edge.direction === "forward" ? connection.to : connection.from;
    steps.push(Object.freeze({
      connectionId: connection.id,
      label: connection.presentation?.label || connection.label || connection.id,
      kind: connection.kind,
      direction: part.edge.direction,
      fromSpaceId: from.spaceId,
      toSpaceId: to.spaceId,
    }));
    if (spaces[spaces.length - 1] !== to.spaceId) spaces.push(to.spaceId);
  }

  return Object.freeze({
    spaces: Object.freeze(spaces),
    steps: Object.freeze(steps),
    waypoints: Object.freeze(waypoints),
    cost: distances.get(goalId) || 0,
  });
}

export function findSpatialRoute(runtime, {
  fromSpaceId,
  toSpaceId,
  fromPoint = null,
  toPoint = null,
  linePassable = null,
  waypointCandidates = null,
} = {}) {
  const location = runtime?.location;
  if (!location?.spacesById || !location?.connectionsById) throw new TypeError("runtime must expose a compiled spatial location");
  if (!location.spacesById.has(fromSpaceId)) throw new Error(`unknown route start space ${fromSpaceId}`);
  if (!location.spacesById.has(toSpaceId)) throw new Error(`unknown route target space ${toSpaceId}`);

  const nodes = [
    {id: "@start", spaceId: fromSpaceId, point: fromPoint, kind: "start"},
    {id: "@goal", spaceId: toSpaceId, point: toPoint, kind: "goal"},
  ];

  for (const connection of location.connections) {
    if (!connectionPassable(connection, runtime.getConnectionState(connection.id))) continue;
    nodes.push({id: `${connection.id}:from`, spaceId: connection.from.spaceId, point: connection.from.position, kind: "connection"});
    nodes.push({id: `${connection.id}:to`, spaceId: connection.to.spaceId, point: connection.to.position, kind: "connection"});
  }

  if (typeof waypointCandidates === "function") {
    for (const space of location.spaces) {
      const candidates = waypointCandidates(space.id) || [];
      for (let index = 0; index < candidates.length; index += 1) {
        const point = candidates[index];
        if (point) nodes.push({id: `@way:${space.id}:${index}`, spaceId: space.id, point, kind: "detour"});
      }
    }
  }

  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const graph = new Map(nodes.map(node => [node.id, []]));
  addWalkEdges(nodes, graph, linePassable);

  for (const connection of location.connections) {
    if (!connectionPassable(connection, runtime.getConnectionState(connection.id))) continue;
    const fromId = `${connection.id}:from`;
    const toId = `${connection.id}:to`;
    if (!graph.has(fromId) || !graph.has(toId)) continue;
    const cost = Math.max(0.001, Number(connection.cost) || 1);
    addEdge(graph, fromId, toId, cost, {kind: "connection", connectionId: connection.id, direction: "forward"});
    if (connection.bidirectional) addEdge(graph, toId, fromId, cost, {kind: "connection", connectionId: connection.id, direction: "reverse"});
  }

  const distances = new Map([["@start", 0]]);
  const previous = new Map();
  const pending = new Set(nodes.map(node => node.id));
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
    if (current === "@goal") break;
    for (const edge of graph.get(current) || []) {
      if (!pending.has(edge.to)) continue;
      const candidate = currentDistance + edge.cost;
      if (candidate < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, {from: current, edge});
      }
    }
  }

  return reconstructRoute(runtime, nodesById, previous, distances, "@start", "@goal", fromSpaceId);
}

export function describeRoute(runtime, route) {
  if (!route) return "Маршрут недоступен";
  if (!route.steps.length) return "Цель находится в текущем пространстве";
  return route.steps.map(step => {
    const destination = runtime.location.spacesById.get(step.toSpaceId);
    return `${step.label}: ${destination?.presentation?.label || destination?.label || step.toSpaceId}`;
  }).join(". ");
}
