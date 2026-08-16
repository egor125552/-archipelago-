"use strict";

import {SPATIAL_LAB_LOCATION} from "./spatial-lab/location.js";

function freeRoamLabDefinition() {
  return Object.freeze({
    ...SPATIAL_LAB_LOCATION,
    worldTransform: Object.freeze({position: Object.freeze({x: 272, y: 14, z: 2}), yaw: 0}),
    spaces: Object.freeze(SPATIAL_LAB_LOCATION.spaces.map(space => space.id === "lab.remote.store"
      ? Object.freeze({...space, transform: Object.freeze({position: Object.freeze({x: 0, y: 40, z: 0}), yaw: 0})})
      : space)),
  });
}

export const FREE_ROAM_SPATIAL_LOCATIONS = Object.freeze([
  Object.freeze({
    definition: freeRoamLabDefinition(),
    portal: Object.freeze({
      id: "portal.spatial.lab.shore",
      position: Object.freeze({x: 210, y: 55, z: 0}),
      radius: 4,
      exitRadius: 3,
      discoverRadius: 18,
      spawnId: "lab.spawn.entry",
      exitAnchorId: "lab.anchor.entry",
      outsideLabel: "берег",
    }),
  }),
]);
