"use strict";

import {emit, finite, modulePosition, moduleUserLabel, values} from "./vessel-spatial-damage-core.js?v=1";

function inputAttack(world, playerIndex) {
  return Boolean(
    world?.freeActivities?.inputs?.[playerIndex]?.attack
    || world?.operationInputs?.[playerIndex]?.attack
    || world?.inputs?.[playerIndex]?.attack
  );
}

function mountedModulesBySide(entry) {
  const mounted = values(entry?.definition?.modules).filter(module => module?.type === "mounted-weapon");
  return mounted.sort((left, right) => {
    const leftPosition = modulePosition(entry, left.id)?.position || {x: 0};
    const rightPosition = modulePosition(entry, right.id)?.position || {x: 0};
    return finite(leftPosition.x) - finite(rightPosition.x);
  });
}

function syncLegacyMountedWeapons(world, entry, announceInput = false) {
  const controller = world?.freeDualTurretBoat;
  if (!controller || String(controller.boatId) !== String(entry?.boat?.id) || !Array.isArray(controller.turrets)) return;
  const modules = mountedModulesBySide(entry);
  if (!modules.length) return;
  const turrets = [...controller.turrets].sort((left, right) => finite(left?.side) - finite(right?.side));
  for (let index = 0; index < Math.min(modules.length, turrets.length); index += 1) {
    const module = entry.instance?.modules?.[modules[index].id];
    const turret = turrets[index];
    if (!module || !turret) continue;
    const disabled = module.enabled === false || finite(module.health, 100) <= 0;
    if (disabled) {
      if (!turret.spatialDisabled && Number.isFinite(Number(turret.cooldown))) turret.spatialCooldownBeforeDisable = Math.max(0, Number(turret.cooldown) || 0);
      turret.spatialDisabled = true;
      turret.cooldown = Number.POSITIVE_INFINITY;
      const playerIndex = entry.boat?.crew?.[turret.seatIndex ?? index];
      const now = finite(world.time);
      if (announceInput && Number.isInteger(playerIndex) && inputAttack(world, playerIndex) && now - finite(turret.spatialDamageDeniedAt, -999) >= 1.2) {
        turret.spatialDamageDeniedAt = now;
        emit(world, "dual-turret-denied", `${moduleUserLabel(entry, modules[index].id)} повреждена и не может стрелять. Сначала отремонтируй её.`, [playerIndex], {
          sourcePlayer: playerIndex, boatId: entry.boat.id, moduleId: modules[index].id, turretId: turret.id,
        });
      }
    } else if (turret.spatialDisabled) {
      turret.spatialDisabled = false;
      if (!Number.isFinite(Number(turret.cooldown))) turret.cooldown = Math.max(0, finite(turret.spatialCooldownBeforeDisable));
      delete turret.spatialCooldownBeforeDisable;
    }
  }
}

export function syncLegacyVesselDamageEffects(context = {}, announceInput = false) {
  const world = context?.world;
  if (!world) return;
  for (const entry of context?.nativeVessels || []) syncLegacyMountedWeapons(world, entry, announceInput);
}
