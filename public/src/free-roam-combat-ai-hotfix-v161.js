"use strict";

import {applyCombatAiHotfix} from "./free-roam-combat-ai-hotfix-v160.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiHotfixV161 ||= {
    seed: 0x61ca77,
    openingEncounterId: null,
  };
  const state = world.freeCombatAiHotfixV161;
  if (!Number.isFinite(state.seed)) state.seed = 0x61ca77;
  return state;
}

function nextRandom(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

function livingPlayers(world) {
  return (world.players || [])
    .map((player, index) => ({player, index, actor: ["boat", "roof"].includes(player?.mode)
      ? world.boats?.[player.activeBoat] || player
      : player}))
    .filter(({player, index, actor}) => world.freeActivities?.presence?.[index] && player?.combat?.alive && actor);
}

function activePursuers(world) {
  const result = [];
  const primary = world.freeActivities?.marauder;
  if (primary?.active && !primary.destroyed) result.push(primary);
  if (world.freePursuerSquad?.activated) {
    for (const escort of world.freePursuerSquad.escorts || []) {
      if (escort?.active && !escort.destroyed) result.push(escort);
    }
  }
  return result;
}

function activeThreatBoats(world) {
  const result = [...activePursuers(world)];
  for (const boat of world.freeEnemyBoats?.boats || []) {
    if (boat?.active && !boat.destroyed) result.push(boat);
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed) result.push(heavy);
  return result;
}

function hasDismountedGunner(world, pursuerId) {
  if ((world.freeHostileGunners?.gunners || []).some(gunner => gunner?.active && !gunner.destroyed && gunner.pursuerId === pursuerId)) return true;
  return (world.freeHostileActors?.actors || []).some(actor => (
    actor?.active && !actor.destroyed && actor.boatId === pursuerId && actor.state !== "aboard"
  ));
}

function pursuerWeapon(state, pursuer, primary) {
  if (pursuer === primary) {
    state.hotfixPrimaryWeapon ||= {fireCooldown: 0.45, aimRemaining: 0, burstRemaining: 0, burstCooldown: 0};
    return state.hotfixPrimaryWeapon;
  }
  pursuer.hotfixWeapon ||= {fireCooldown: 0.55, aimRemaining: 0, burstRemaining: 0, burstCooldown: 0};
  return pursuer.hotfixWeapon;
}

function spawnPursuerProjectile(world, state, pursuer, target) {
  state.projectiles ||= [];
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  if (state.projectiles.length >= 20) return false;
  const angle = bearing(pursuer, target.actor) * Math.PI / 180;
  const id = `enemy-bullet-${state.nextProjectileId++}`;
  state.projectiles.push({
    id,
    sourcePursuerId: pursuer.id,
    targetPlayer: target.index,
    sourceX: pursuer.x,
    sourceY: pursuer.y,
    x: pursuer.x + Math.sin(angle) * 7,
    y: pursuer.y - Math.cos(angle) * 7,
    vx: Math.sin(angle) * 64,
    vy: -Math.cos(angle) * 64,
    damage: 3,
    ttl: 7.4,
    nearMissAnnounced: Array.from({length: world.players.length}, () => false),
  });
  emit(world, "enemy-gun-shot", "", livingPlayers(world).map(item => item.index), {
    sourcePlayer: -1,
    sourcePursuerId: pursuer.id,
    projectileId: id,
    targetPlayer: target.index,
    x: pursuer.x,
    y: pursuer.y,
    heading: bearing(pursuer, target.actor),
  });
  return true;
}

function applyReservePursuerPressure(world, dt, hotfixState) {
  const state = world.freePursuerSquad;
  if (!state) return;
  const pursuers = activePursuers(world);
  const living = livingPlayers(world);
  if (!pursuers.length || !living.length) return;

  const originallyAssigned = new Set(Object.keys(state.assignments || {}));
  const assignments = {};
  const pressure = new Map(living.map(item => [item.index, 0]));
  const primary = world.freeActivities?.marauder;

  for (const pursuer of pursuers) {
    const previous = state.assignments?.[pursuer.id];
    const target = [...living].sort((left, right) => {
      const load = (pressure.get(left.index) || 0) - (pressure.get(right.index) || 0);
      if (load) return load;
      if (left.index === previous) return -1;
      if (right.index === previous) return 1;
      return distance(pursuer, left.actor) - distance(pursuer, right.actor);
    })[0];
    assignments[pursuer.id] = target.index;
    pressure.set(target.index, (pressure.get(target.index) || 0) + 1);
    pursuer.targetPlayer = target.index;

    if (originallyAssigned.has(pursuer.id) || hasDismountedGunner(world, pursuer.id)) continue;
    const metres = distance(pursuer, target.actor);
    const weapon = pursuerWeapon(state, pursuer, primary);
    weapon.fireCooldown = Math.max(0, (Number(weapon.fireCooldown) || 0) - dt);
    weapon.aimRemaining = Math.max(0, (Number(weapon.aimRemaining) || 0) - dt);
    weapon.burstCooldown = Math.max(0, (Number(weapon.burstCooldown) || 0) - dt);

    if (weapon.aimRemaining > 0) continue;
    if (weapon.burstRemaining > 0) {
      if (weapon.burstCooldown > 0) continue;
      if (!spawnPursuerProjectile(world, state, pursuer, target)) {
        weapon.burstRemaining = 0;
        weapon.fireCooldown = 0.45;
        continue;
      }
      weapon.burstRemaining -= 1;
      weapon.burstCooldown = 0.15 + nextRandom(hotfixState) * 0.12;
      if (weapon.burstRemaining <= 0) weapon.fireCooldown = 0.9 + nextRandom(hotfixState) * 1.7;
      continue;
    }
    if (weapon.fireCooldown > 0 || metres > 455) continue;
    weapon.aimRemaining = 0.55 + nextRandom(hotfixState) * 0.35;
    weapon.burstRemaining = nextRandom(hotfixState) < 0.45 ? 1 : nextRandom(hotfixState) < 0.72 ? 2 : 3;
    emit(world, "pursuer-aim", "", [target.index], {
      sourcePlayer: -1,
      sourcePursuerId: pursuer.id,
      targetPlayer: target.index,
      eta: weapon.aimRemaining,
      x: pursuer.x,
      y: pursuer.y,
    });
  }
  state.assignments = assignments;
}

function createOpeningActor(id, boat, targetPlayer, serial) {
  const weapon = serial % 3 === 0 ? "knife" : serial % 2 ? "automatic" : "pistol";
  const maxHealth = weapon === "knife" ? 58 : weapon === "automatic" ? 52 : 44;
  return {
    id,
    boatId: boat.id,
    targetPlayer,
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    state: "aboard",
    weapon,
    health: maxHealth,
    maxHealth,
    active: true,
    destroyed: false,
    elite: false,
    fireCooldown: 0.45 + (serial % 5) * 0.23,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0.3,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: serial % 2 ? 2.2 : -2.2,
    strandedAt: 0,
    stepCooldown: 0,
    smartAmmo: weapon === "automatic" ? 8 : weapon === "pistol" ? 5 : 0,
    threatPhase: 1,
    finalWave: false,
  };
}

function strengthenOpeningActors(world, state) {
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5) return;
  const living = livingPlayers(world);
  const carriers = activeThreatBoats(world);
  if (!living.length || !carriers.length) return;
  world.freeHostileActors ||= {active: true, level: 5, actors: [], projectiles: [], nextProjectileId: 1};
  const hostile = world.freeHostileActors;
  hostile.actors ||= [];
  hostile.active = true;
  hostile.level = Math.max(5, Number(hostile.level) || 0);
  const desired = living.length > 1 ? 10 : 8;
  let count = hostile.actors.filter(actor => actor?.active && !actor.destroyed).length;
  let serial = 1;
  const encounterId = Number(director.encounterId) || 0;
  while (count < desired) {
    const id = `v161-opening-${encounterId}-${serial}`;
    if (!hostile.actors.some(actor => actor.id === id)) {
      const boat = carriers[count % carriers.length];
      const target = living[count % living.length];
      hostile.actors.push(createOpeningActor(id, boat, target.index, serial));
      count += 1;
    }
    serial += 1;
  }
  state.openingEncounterId = encounterId;
}

export function applyCombatAiHotfixV161(world, dt, helpers = {}) {
  applyCombatAiHotfix(world, dt, helpers);
  const state = ensureState(world);
  strengthenOpeningActors(world, state);
  applyReservePursuerPressure(world, dt, state);
}
