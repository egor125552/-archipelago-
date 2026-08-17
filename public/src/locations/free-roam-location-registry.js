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
      // The developer log showed the blind approach repeatedly passing the
      // entrance at 7.9-12.8 m. Discovery is 18 m, so the action radius must
      // remain usable inside the spoken guidance envelope.
      radius: 13,
      exitRadius: 3,
      discoverRadius: 18,
      spawnId: "lab.spawn.entry",
      exitAnchorId: "lab.anchor.entry",
      outsideLabel: "берег",
    }),
  }),
]);
