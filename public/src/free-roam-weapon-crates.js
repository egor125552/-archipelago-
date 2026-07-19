"use strict";

export function grantWeaponFromCrate(world, crate, playerIndex, emit) {
  if (crate?.kind !== "automatic" || Number.isInteger(crate.weaponGrantedTo)) return false;
  const combat = world.players[playerIndex]?.combat;
  if (!combat) return false;
  combat.weapons.automatic = true;
  combat.ammo += 48;
  combat.equipped = "automatic";
  crate.weaponGrantedTo = playerIndex;
  emit?.(
    world,
    "automatic-ready",
    "Автомат снят с ящика и готов. Боезапас 48. Сам ящик всё равно доставь к причалу.",
    [playerIndex],
    {
      sourcePlayer: playerIndex,
      crateId: crate.id,
      kind: crate.kind,
      x: world.players[playerIndex].x,
      y: world.players[playerIndex].y,
    },
  );
  return true;
}

export function automaticCargoDelivered(world) {
  return Boolean(
    world.freeActivities?.crates?.some(
      crate => crate.kind === "automatic" && crate.state === "consumed",
    ),
  );
}
