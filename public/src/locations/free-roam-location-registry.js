"use strict";

import {COAST_RESCUE_CENTER_LOCATION} from "./coast-rescue-center/location.js";
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
      // Keep the laboratory outside the merchant's 35 m audio envelope plus
      // the laboratory's own 18 m discovery envelope. The old portal at
      // (210, 55) was only about three metres from the merchant at (210, 58).
      position: Object.freeze({x: 270, y: 55, z: 0}),
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
  Object.freeze({
    definition: COAST_RESCUE_CENTER_LOCATION,
    portal: Object.freeze({
      id: "portal.coast.rescue-center.shore",
      position: Object.freeze({x: 150, y: 18, z: 0}),
      // The building is meant to be found by sound, not by pixel-perfect
      // positioning. The action zone deliberately sits well inside discovery.
      radius: 12,
      exitRadius: 3.5,
      discoverRadius: 22,
      spawnId: "rescue.spawn.entry",
      exitAnchorId: "rescue.anchor.entry",
      outsideLabel: "берег у спасательного центра",
    }),
  }),
]);
