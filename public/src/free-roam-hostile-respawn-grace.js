"use strict";

const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];

function graceUntil(world, playerIndex) {
  return Number(world?.freeThreatDirector?.graceUntil?.[playerIndex]) || 0;
}

export function hostileRespawnGraceActive(world, playerIndex) {
  return Number.isInteger(playerIndex)
    && graceUntil(world, playerIndex) > (Number(world?.time) || 0);
}

export function enforceHostileRespawnGrace(world) {
  const now = Number(world?.time) || 0;
  let removedProjectiles = 0;
  let heldActors = 0;
  let removedBombRequests = 0;

  const hostile = world?.freeHostileActors;
  if (hostile) {
    const projectiles = values(hostile.projectiles);
    hostile.projectiles = projectiles.filter(projectile => {
      if (!hostileRespawnGraceActive(world, Number(projectile?.targetPlayer))) return true;
      removedProjectiles += 1;
      return false;
    });

    for (const actor of values(hostile.actors)) {
      const targetPlayer = Number(actor?.targetPlayer);
      if (!actor?.active || actor.destroyed || !hostileRespawnGraceActive(world, targetPlayer)) continue;
      const remaining = Math.max(0, graceUntil(world, targetPlayer) - now);
      actor.aimRemaining = 0;
      actor.burstRemaining = 0;
      actor.windupRemaining = 0;
      actor.fireCooldown = Math.max(Number(actor.fireCooldown) || 0, remaining);
      actor.attackCooldown = Math.max(Number(actor.attackCooldown) || 0, remaining);
      actor.bombCooldown = Math.max(Number(actor.bombCooldown) || 0, remaining);
      actor.targetLockUntil = 0;
      heldActors += 1;
    }
  }

  const boss = world?.freeEliteBoatBoss;
  if (boss) {
    boss.projectiles = values(boss.projectiles).filter(projectile => {
      if (!hostileRespawnGraceActive(world, Number(projectile?.targetPlayer))) return true;
      removedProjectiles += 1;
      return false;
    });
    boss.bombRequests = values(boss.bombRequests).filter(request => {
      if (!hostileRespawnGraceActive(world, Number(request?.targetPlayer))) return true;
      removedBombRequests += 1;
      return false;
    });
  }

  return {removedProjectiles, heldActors, removedBombRequests};
}
