"use strict";

import {deliverCarriedCargoAtDock} from "./free-roam-cargo-actions.js?v=30";
import {isFootDockZone} from "./free-roam-cargo-rules.js?v=30";

const AUTO_DELIVERY_SECONDS = 0.45;

function ensureFootDockState(world) {
  world.freeFootDock ||= {
    progress: Array.from({length: world.players.length}, () => 0),
  };
  while (world.freeFootDock.progress.length < world.players.length) {
    world.freeFootDock.progress.push(0);
  }
  return world.freeFootDock;
}

export function updateFootDockDelivery(world, dt, rewardPlayer, emit) {
  const state = ensureFootDockState(world);
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const crateId = player?.combat?.carriedCrate;
    const crate = crateId
      ? world.freeActivities.crates.find(candidate => candidate.id === crateId)
      : null;
    if (!crate || !isFootDockZone(player)) {
      state.progress[index] = 0;
      continue;
    }
    state.progress[index] += dt;
    if (state.progress[index] < AUTO_DELIVERY_SECONDS) continue;
    state.progress[index] = 0;
    deliverCarriedCargoAtDock(world, index, crate, rewardPlayer, emit);
  }
}
