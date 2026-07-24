"use strict";

import {activePursuerById} from "./free-roam-pursuer-squad.js?v=33";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function ensureHostileGunners(world) {
  world.freeHostileGunners ||= {gunners: [], projectiles: [], eliminatedPursuers: [], nextProjectileId: 1};
  const state = world.freeHostileGunners;
  state.gunners ||= [];
  state.projectiles ||= [];
  state.eliminatedPursuers ||= [];
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  return state;
}

export function activeHostileGunners(world) {
  return ensureHostileGunners(world).gunners.filter(gunner => gunner.active && !gunner.destroyed);
}

function createGunner(shooter, targetPlayer) {
  return {
    id: `gunner-${shooter.id}`,
    pursuerId: shooter.id,
    targetPlayer,
    x: clamp(shooter.x, 7, 413),
    y: 69,
    heading: 180,
    health: 44,
    active: true,
    destroyed: false,
    returning: false,
    fireCooldown: 1.2,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
  };
}

function syncGunners(world, state) {
  const assignments = world.freePursuerSquad?.assignments || {};
  const wanted = new Map();
  for (const [pursuerId, playerIndex] of Object.entries(assignments)) {
    if (state.eliminatedPursuers.includes(pursuerId)) continue;
    const shooter = activePursuerById(world, pursuerId);
    const player = world.players?.[playerIndex];
    if (!shooter || !player?.combat?.alive || player.mode !== "foot") continue;
    const shorePoint = {x: player.x, y: 78};
    if (distance(shooter, shorePoint) <= 52) wanted.set(pursuerId, Number(playerIndex));
  }

  for (const [pursuerId, targetPlayer] of wanted) {
    let gunner = state.gunners.find(candidate => candidate.pursuerId === pursuerId && !candidate.destroyed);
    if (!gunner) {
      const shooter = activePursuerById(world, pursuerId);
      gunner = createGunner(shooter, targetPlayer);
      state.gunners.push(gunner);
      emit(
        world,
        "pursuer-gunner-landed",
        "Стрелок вышел из катера на берег и преследует тебя пешком.",
        [targetPlayer],
        {sourcePlayer: -1, sourcePursuerId: pursuerId, gunnerId: gunner.id, x: gunner.x, y: gunner.y},
      );
    }
    gunner.targetPlayer = targetPlayer;
    gunner.returning = false;
    gunner.active = true;
  }

  for (const gunner of state.gunners) {
    if (!gunner.active || gunner.destroyed || wanted.has(gunner.pursuerId)) continue;
    const shooter = activePursuerById(world, gunner.pursuerId);
    const targetPresent = world.freeActivities?.presence?.[gunner.targetPlayer];
    if (!shooter && targetPresent) {
      gunner.returning = false;
      continue;
    }
    if (!shooter && !targetPresent) {
      gunner.active = false;
      continue;
    }
    gunner.returning = true;
    gunner.aimRemaining = 0;
    gunner.burstRemaining = 0;
  }
}

function moveGunner(world, gunner, dt) {
  const shooter = activePursuerById(world, gunner.pursuerId);
  const player = world.players?.[gunner.targetPlayer];
  const target = gunner.returning
    ? {x: clamp(shooter?.x ?? gunner.x, 7, 413), y: 70}
    : player;
  if (!target) {
    gunner.active = false;
    return;
  }
  const dx = target.x - gunner.x;
  const dy = target.y - gunner.y;
  const metres = Math.hypot(dx, dy);
  if (gunner.returning && metres <= 5) {
    gunner.active = false;
    emit(
      world,
      "pursuer-gunner-boarded",
      "Стрелок вернулся в катер.",
      [gunner.targetPlayer],
      {sourcePlayer: -1, sourcePursuerId: gunner.pursuerId, gunnerId: gunner.id, x: gunner.x, y: gunner.y},
    );
    return;
  }
  if (metres < 0.01) return;
  gunner.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
  const desiredSpeed = gunner.returning ? 10 : metres > 25 ? 8.5 : metres < 14 ? -5.5 : 0;
  gunner.x = clamp(gunner.x + dx / metres * desiredSpeed * dt, 5, 415);
  gunner.y = clamp(gunner.y + dy / metres * desiredSpeed * dt, 5, 70);
}

function spawnProjectile(world, state, gunner) {
  const player = world.players?.[gunner.targetPlayer];
  if (!player?.combat?.alive || player.mode !== "foot" || state.projectiles.length >= 16) return false;
  const angle = Math.atan2(player.x - gunner.x, -(player.y - gunner.y));
  state.projectiles.push({
    id: `gunner-bullet-${state.nextProjectileId++}`,
    gunnerId: gunner.id,
    targetPlayer: gunner.targetPlayer,
    x: gunner.x,
    y: gunner.y,
    sourceX: gunner.x,
    sourceY: gunner.y,
    vx: Math.sin(angle) * 72,
    vy: -Math.cos(angle) * 72,
    ttl: 4,
  });
  emit(world, "enemy-gun-shot", "", [0, 1], {
    sourcePlayer: -1,
    sourcePursuerId: gunner.pursuerId,
    gunnerId: gunner.id,
    targetPlayer: gunner.targetPlayer,
    x: gunner.x,
    y: gunner.y,
    heading: gunner.heading,
  });
  return true;
}

function updateWeapon(world, state, gunner, dt) {
  if (gunner.returning) return;
  const player = world.players?.[gunner.targetPlayer];
  if (!world.freeActivities?.presence?.[gunner.targetPlayer] || !player?.combat?.alive || player.mode !== "foot") return;
  const metres = distance(gunner, player);
  gunner.fireCooldown = Math.max(0, gunner.fireCooldown - dt);
  gunner.burstCooldown = Math.max(0, gunner.burstCooldown - dt);
  if (gunner.aimRemaining > 0) {
    gunner.aimRemaining = Math.max(0, gunner.aimRemaining - dt);
    if (gunner.aimRemaining > 0) return;
    gunner.burstRemaining = 4;
  }
  if (gunner.burstRemaining > 0) {
    if (gunner.burstCooldown > 0) return;
    if (!spawnProjectile(world, state, gunner)) {
      gunner.burstRemaining = 0;
      return;
    }
    gunner.burstRemaining -= 1;
    gunner.burstCooldown = 0.15;
    if (gunner.burstRemaining <= 0) gunner.fireCooldown = 1.7;
    return;
  }
  if (gunner.fireCooldown > 0 || metres > 155) return;
  gunner.aimRemaining = 0.8;
  emit(world, "pursuer-aim", "", [gunner.targetPlayer], {
    sourcePlayer: -1,
    sourcePursuerId: gunner.pursuerId,
    gunnerId: gunner.id,
    targetPlayer: gunner.targetPlayer,
    eta: gunner.aimRemaining,
    x: gunner.x,
    y: gunner.y,
  });
}

function segmentHit(from, to, actor, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return distance(from, actor) <= radius;
  const amount = clamp(((actor.x - from.x) * dx + (actor.y - from.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(actor.x - (from.x + dx * amount), actor.y - (from.y + dy * amount)) <= radius;
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const next = {x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt};
    let hit = false;
    for (const boat of world.boats || []) {
      if (boat.sunk || !segmentHit(projectile, next, boat, 6.6)) continue;
      boat.hull = clamp(boat.hull - 3, 0.05, 100);
      boat.leak = clamp((Number(boat.leak) || 0) + 0.14, 0, 16);
      const occupants = world.players
        .map((player, index) => ({player, index}))
        .filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id)
        .map(({index}) => index);
      const targets = occupants.length ? occupants : [boat.owner].filter(Number.isInteger);
      const text = occupants.length
        ? `Пуля стрелка попала в твою лодку. Корпус ${Math.round(boat.hull)}.`
        : `Пуля стрелка попала в твою пустую лодку. Корпус ${Math.round(boat.hull)}.`;
      emit(world, "enemy-bullet-boat-hit", text, targets, {
        sourcePlayer: -1, gunnerId: projectile.gunnerId, targetBoat: boat.id, x: next.x, y: next.y,
      });
      hit = true;
      break;
    }
    if (!hit) {
      for (let index = 0; index < (world.players || []).length; index += 1) {
        const player = world.players[index];
        if (!world.freeActivities?.presence?.[index] || !player?.combat?.alive || player.mode !== "foot") continue;
        if (!segmentHit(projectile, next, player, 1.9)) continue;
        helpers?.damagePlayer?.(world, index, 4, {
          weapon: "automatic",
          eventType: "gun-hit",
          sourcePoint: {x: projectile.sourceX, y: projectile.sourceY},
        });
        hit = true;
        break;
      }
    }
    if (hit) continue;
    projectile.x = next.x;
    projectile.y = next.y;
    projectile.ttl -= dt;
    if (projectile.ttl > 0 && projectile.x >= -8 && projectile.x <= 428 && projectile.y >= -8 && projectile.y <= 328) {
      survivors.push(projectile);
    }
  }
  state.projectiles = survivors;
}

export function damageHostileGunner(world, gunnerId, amount, sourcePlayer) {
  const gunner = activeHostileGunners(world).find(candidate => candidate.id === gunnerId);
  if (!gunner || amount <= 0) return false;
  gunner.health = clamp(gunner.health - amount, 0, 44);
  emit(world, "gunner-hit", `Попадание по стрелку. Осталось ${Math.round(gunner.health)}.`, [sourcePlayer], {
    sourcePlayer, gunnerId, damage: amount, health: gunner.health, x: gunner.x, y: gunner.y,
  });
  if (gunner.health > 0) return true;
  gunner.active = false;
  gunner.destroyed = true;
  gunner.burstRemaining = 0;
  const state = ensureHostileGunners(world);
  if (!state.eliminatedPursuers.includes(gunner.pursuerId)) state.eliminatedPursuers.push(gunner.pursuerId);
  emit(world, "gunner-destroyed", "Стрелок преследователя повержен.", [sourcePlayer, gunner.targetPlayer], {
    sourcePlayer, gunnerId, targetPlayer: gunner.targetPlayer, x: gunner.x, y: gunner.y,
  });
  return true;
}

export function updateHostileGunners(world, dt, helpers = {}) {
  const state = ensureHostileGunners(world);
  syncGunners(world, state);
  for (const gunner of activeHostileGunners(world)) {
    moveGunner(world, gunner, dt);
    if (gunner.active) updateWeapon(world, state, gunner, dt);
  }
  updateProjectiles(world, state, dt, helpers);
  return state;
}
