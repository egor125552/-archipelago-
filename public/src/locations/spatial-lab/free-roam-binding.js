"use strict";

import {normalizeLocationDefinition} from "../../spatial/spatial-contract.js";
import {localToWorld, resolveSpaceWorldTransform} from "../../spatial/spatial-transform.js";
import {SPATIAL_LAB_LOCATION} from "./location.js";

const location = normalizeLocationDefinition(SPATIAL_LAB_LOCATION);
const spacesById = new Map(location.spaces.map(space => [space.id, space]));

function anchor(anchorId) {
  for (const space of location.spaces) {
    const found = space.anchors.find(candidate => candidate.id === anchorId);
    if (found) return {space, anchor: found};
  }
  throw new Error(`missing spatial lab anchor ${anchorId}`);
}

function endpoint(spaceId, position, radius = 2.8) {
  const world = localToWorld(location, spaceId, position);
  const transform = resolveSpaceWorldTransform(location, spaceId);
  return Object.freeze({
    locationId: location.id,
    spaceId,
    position: Object.freeze(world),
    floorZ: transform.position.z,
    radius,
  });
}

function endpointFromAnchor(anchorId, radius = 2.8) {
  const found = anchor(anchorId);
  return endpoint(found.space.id, found.anchor.position, radius);
}

function spaceBinding(spaceId) {
  const space = spacesById.get(spaceId);
  if (!space) throw new Error(`missing spatial lab space ${spaceId}`);
  const worldPoints = space.shape.outer.map(point => localToWorld(location, spaceId, point));
  const transform = resolveSpaceWorldTransform(location, spaceId);
  return Object.freeze({
    id: space.id,
    label: space.label,
    floorZ: transform.position.z,
    bounds: Object.freeze({
      minX: Math.min(...worldPoints.map(point => point.x)),
      maxX: Math.max(...worldPoints.map(point => point.x)),
      minY: Math.min(...worldPoints.map(point => point.y)),
      maxY: Math.max(...worldPoints.map(point => point.y)),
    }),
  });
}

const entry = endpointFromAnchor("lab.anchor.entry", 3);
const stairsBottom = endpointFromAnchor("lab.anchor.stairs.bottom", 2.7);
const stairsTop = endpointFromAnchor("lab.anchor.stairs.top", 2.7);

export const SPATIAL_LAB_FREE_ROAM_BINDING = Object.freeze({
  id: location.id,
  label: location.label,
  outsideLabel: "берег",
  spaces: Object.freeze([
    spaceBinding("lab.yard"),
    spaceBinding("lab.upper.room"),
  ]),
  passages: Object.freeze([
    Object.freeze({
      id: "world.passage.shore-to-spatial-lab",
      label: "Вход в пространственную лабораторию",
      bidirectional: true,
      from: Object.freeze({
        locationId: null,
        spaceId: null,
        position: Object.freeze({x: 210, y: 55, z: 0}),
        floorZ: 0,
        heading: 0,
        radius: 13,
        discoverRadius: 18,
      }),
      to: Object.freeze({...entry, heading: 0}),
    }),
    Object.freeze({
      id: "lab.connection.stairs",
      label: "Лестница наверх",
      bidirectional: true,
      from: Object.freeze({...stairsBottom, heading: 0}),
      to: Object.freeze({...stairsTop, heading: 180}),
    }),
  ]),
});
