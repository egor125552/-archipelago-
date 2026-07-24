"use strict";

function live(items) {
  return (items || []).some(item => item?.active && !item?.destroyed);
}

export function contractCombatActive(world) {
  return Boolean(
    world?.freeContracts?.encounterActive
    || world?.freeContracts?.activeContract?.phase === "combat"
    || world?.freeThreatDirector?.active
    || live(world?.freeEnemyBoats?.boats)
    || live(world?.freeHostileActors?.actors)
    || live(world?.freeHostileGunners?.gunners)
    || (world?.freeHeavyPursuer?.boat?.active && !world.freeHeavyPursuer.boat.destroyed)
  );
}

export function combatMenuActive(world) {
  return Boolean(world?.freeScenario?.phase === "pursuit" || contractCombatActive(world));
}
