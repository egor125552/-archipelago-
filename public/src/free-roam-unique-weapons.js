"use strict";

export function retireClaimedKnifeCrates(world) {
  const knifeOwned = world.players?.some(player => player?.combat?.weapons?.knife);
  if (!knifeOwned) return false;

  let changed = false;
  for (const crate of world.freeActivities?.crates || []) {
    if (crate.kind !== "knife" || !["world", "delivered"].includes(crate.state)) continue;
    crate.state = "consumed";
    crate.carriedBy = null;
    crate.stowedBoat = null;
    crate.respawnAt = 0;
    changed = true;
  }
  return changed;
}
