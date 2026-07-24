"use strict";

import {activePursuers, activePursuerById} from "./free-roam-pursuer-squad.js?v=33";
import {activeEnemyBoats, enemyBoatById} from "./free-roam-enemy-boats.js?v=2";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const bearing = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function ensureHostileActors(world) {
  world.freeHostileActors ||= {active: false, level: 0, actors: [], projectiles: [], nextProjectileId: 1, spawnedEncounterId: null};
  const state = world.freeHostileActors;
  state.actors ||= [];
  state.projectiles ||= [];
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  if (!Number.isFinite(state.level)) state.level = 0;
  return state;
}

export function activeHostileActors(world) {
  return ensureHostileActors(world).actors.filter(actor => actor.active && !actor.destroyed);
}

export function hostileActorById(world, id) {
  return activeHostileActors(world).find(actor => actor.id === id) || null;
}

function boatById(world, id) {
  return activePursuerById(world, id) || enemyBoatById(world, id) || (world.freeHeavyPursuer?.boat?.id === id && world.freeHeavyPursuer.boat.active ? world.freeHeavyPursuer.boat : null);
}

function createActor(id, boat, weapon, targetPlayer, elite = false) {
  const maxHealth = elite ? 120 : weapon === "knife" ? 58 : weapon === "automatic" ? 52 : 44;
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
    elite,
    fireCooldown: 0.8,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: 0,
    strandedAt: 0,
    stepCooldown: 0,
  };
}

function sourceBoats(world) {
  const boats = [...activePursuers(world), ...activeEnemyBoats(world)];
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed) boats.push(heavy);
  return boats;
}

export function startHostileActors(world, level, encounterId, assignments = {}) {
  const state = ensureHostileActors(world);
  state.level = level;
  state.active = level >= 3;
  state.projectiles = [];
  state.spawnedEncounterId = encounterId;
  state.actors = [];
  if (!state.active) return state;
  let serial = 1;
  const coop = (world.freeActivities?.presence || []).filter(Boolean).length > 1;
  const maximumActors = level >= 5 ? (coop ? 6 : 4) : level >= 4 ? 6 : 4;
  for (const boat of sourceBoats(world)) {
    if (state.actors.length >= maximumActors) break;
    const targetPlayer = Number.isInteger(assignments[boat.id]) ? assignments[boat.id] : serial % 2;
    const seats = Math.max(1, Number(boat.crewSeats) || (level >= 4 && ["pursuer-1", "pursuer-2"].includes(boat.id) ? 2 : 1));
    for (let seat = 0; seat < seats && state.actors.length < maximumActors; seat += 1) {
      const weapon = level >= 4 && (serial + seat) % 4 === 0 ? "knife" : (serial + seat) % 2 ? "automatic" : "pistol";
      const actor = createActor(`hostile-${encounterId}-${serial++}`, boat, weapon, targetPlayer, false);
      actor.seatOffset = seat ? 2.2 : -2.2;
      state.actors.push(actor);
    }
  }
  emit(world, "hostile-crews-ready", "Вражеские экипажи существуют физически: они могут высаживаться, плыть и возвращаться в катера.", [0, 1], {level, count: state.actors.length});
  return state;
}

export function addEliteActor(world, boat, targetPlayer, encounterId) {
  const state = ensureHostileActors(world);
  const actor = createActor(`elite-${encounterId}`, boat, "automatic", targetPlayer, true);
  actor.seatOffset = 0;
  state.actors.push(actor);
  state.active = true;
  return actor;
}

function livingPlayer(world, index) {
  const player = world.players?.[index];
  return world.freeActivities?.presence?.[index] && player?.combat?.alive ? player : null;
}

function chooseTarget(world, actor) {
  const current = livingPlayer(world, actor.targetPlayer);
  if (current && world.time < actor.targetLockUntil) return current;
  const candidates = world.players.map((player, index) => ({player, index})).filter(({player, index}) => livingPlayer(world, index));
  if (!candidates.length) return null;
  candidates.sort((left, right) => distance(actor, left.player) - distance(actor, right.player));
  actor.targetPlayer = candidates[0].index;
  actor.targetLockUntil = world.time + (actor.elite ? 6 : 10);
  return candidates[0].player;
}

function updateAboard(world, actor, boat) {
  if (!boat) {
    actor.state = "swim";
    actor.strandedAt = world.time;
    return;
  }
  const angle = (Number(boat.heading) || 0) * Math.PI / 180;
  actor.x = boat.x + Math.cos(angle) * actor.seatOffset;
  actor.y = boat.y + Math.sin(angle) * actor.seatOffset;
  actor.heading = boat.heading;
  const target = chooseTarget(world, actor);
  if (!target) return;
  const shorePoint = {x: target.x, y: 70};
  const shouldDisembark = target.mode === "foot" && distance(boat, shorePoint) <= (actor.elite ? 68 : 52);
  if (shouldDisembark) {
    actor.state = "disembarking";
    actor.x = boat.x;
    actor.y = 72;
    emit(world, actor.elite ? "elite-landed" : "pursuer-gunner-landed", actor.elite
      ? "Элитный стрелок тяжёлого катера высадился и идёт за тобой."
      : "Вооружённый член экипажа физически вышел из катера на берег.", [actor.targetPlayer], {actorId: actor.id, sourcePursuerId: actor.boatId, x: actor.x, y: actor.y});
  }
}

function nearestBoardingBoat(world, actor) {
  let result = null;
  let best = Infinity;
  for (const boat of sourceBoats(world)) {
    const metres = distance(actor, boat);
    if (metres < best) { best = metres; result = boat; }
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && distance(actor, heavy) < best) result = heavy;
  return result;
}

function moveTowards(actor, target, speed, dt, yMax = 313) {
  const dx = target.x - actor.x;
  const dy = target.y - actor.y;
  const metres = Math.hypot(dx, dy);
  if (metres < 0.001) return metres;
  actor.heading = bearing(actor, target);
  actor.x = clamp(actor.x + dx / metres * speed * dt, 5, 415);
  actor.y = clamp(actor.y + dy / metres * speed * dt, 5, yMax);
  return metres;
}

function updateMovement(world, actor, dt) {
  const boat = boatById(world, actor.boatId);
  if (actor.state === "aboard") return updateAboard(world, actor, boat);
  if (actor.state === "disembarking") {
    actor.y = clamp(actor.y - 7 * dt, 5, 313);
    if (actor.y <= 69) actor.state = "foot";
    return;
  }
  const target = chooseTarget(world, actor);
  if (actor.state === "swim") {
    const boardingBoat = nearestBoardingBoat(world, actor);
    const destination = boardingBoat || {x: actor.x, y: 69};
    const metres = moveTowards(actor, destination, actor.elite ? 5.2 : 4.2, dt);
    if (boardingBoat && metres <= 6) {
      actor.boatId = boardingBoat.id;
      actor.state = "boarding";
    } else if (!boardingBoat && actor.y <= 71) actor.state = "foot";
    else if (world.time - actor.strandedAt > 28) actor.state = "foot";
    return;
  }
  if (actor.state === "boarding") {
    if (!boat) { actor.state = "swim"; return; }
    const metres = moveTowards(actor, boat, 6, dt);
    if (metres <= 4) {
      actor.state = "aboard";
      emit(world, "pursuer-gunner-boarded", "Вражеский стрелок физически вернулся в катер.", [actor.targetPlayer], {actorId: actor.id, sourcePursuerId: actor.boatId, x: actor.x, y: actor.y});
    }
    return;
  }
  if (!target) return;
  if (["boat", "roof"].includes(target.mode)) {
    const boardingBoat = nearestBoardingBoat(world, actor);
    if (boardingBoat && distance(actor, boardingBoat) < 85) {
      actor.boatId = boardingBoat.id;
      actor.state = actor.y >= 70 ? "swim" : "boarding";
      actor.strandedAt = world.time;
    }
    return;
  }
  const metres = distance(actor, target);
  let desiredSpeed = actor.elite ? (metres > 4 ? 10.8 : 0) : actor.weapon === "knife" ? 9.6 : metres > 28 ? 8.2 : metres < 13 ? -4.5 : 0;
  if (actor.elite && actor.windupRemaining > 0) desiredSpeed = 0;
  moveTowards(actor, target, desiredSpeed, dt, 70);
}

function spawnProjectile(world, state, actor, speed = 70) {
  const target = livingPlayer(world, actor.targetPlayer);
  if (!target || !["foot", "swim", "roof"].includes(target.mode) || state.projectiles.length >= 24) return false;
  const angle = bearing(actor, target) * Math.PI / 180;
  state.projectiles.push({id: `hostile-bullet-${state.nextProjectileId++}`, actorId: actor.id, targetPlayer: actor.targetPlayer, x: actor.x, y: actor.y, sourceX: actor.x, sourceY: actor.y, vx: Math.sin(angle) * speed, vy: -Math.cos(angle) * speed, ttl: 4.2, weapon: actor.weapon});
  emit(world, "enemy-gun-shot", "", [0, 1], {sourcePlayer: -1, gunnerId: actor.id, sourcePursuerId: actor.boatId, targetPlayer: actor.targetPlayer, weapon: actor.weapon, x: actor.x, y: actor.y, heading: actor.heading});
  return true;
}

function updateWeapon(world, state, actor, dt, helpers) {
  actor.fireCooldown = Math.max(0, actor.fireCooldown - dt);
  actor.burstCooldown = Math.max(0, actor.burstCooldown - dt);
  actor.attackCooldown = Math.max(0, actor.attackCooldown - dt);
  if (actor.state === "aboard" || actor.state === "boarding" || actor.state === "disembarking") return;
  const target = chooseTarget(world, actor);
  if (!target || !target.combat?.alive) return;
  const metres = distance(actor, target);
  const melee = actor.weapon === "knife" || (actor.elite && metres <= 7.5);
  if (melee) {
    if (actor.windupRemaining > 0) {
      actor.windupRemaining = Math.max(0, actor.windupRemaining - dt);
      if (actor.windupRemaining <= 0 && distance(actor, target) <= (actor.elite ? 8.5 : 5.5)) {
        helpers?.damagePlayer?.(world, actor.targetPlayer, actor.elite ? 32 : 17, {weapon: "knife", heavy: actor.elite, eventType: "enemy-knife-hit", sourcePoint: {x: actor.x, y: actor.y}});
        actor.attackCooldown = actor.elite ? 1.8 : 1.25;
      }
      return;
    }
    if (actor.attackCooldown <= 0 && metres <= (actor.elite ? 8.5 : 5.5)) {
      actor.windupRemaining = actor.elite ? 0.55 : 0.35;
      emit(world, actor.elite ? "elite-knife-windup" : "enemy-knife-windup", actor.elite ? "Элитный стрелок занёс нож. Уклоняйся." : "Ножевой противник готовит удар.", [actor.targetPlayer], {actorId: actor.id, targetPlayer: actor.targetPlayer, eta: actor.windupRemaining, x: actor.x, y: actor.y});
    }
    return;
  }
  if (actor.aimRemaining > 0) {
    actor.aimRemaining = Math.max(0, actor.aimRemaining - dt);
    if (actor.aimRemaining <= 0) actor.burstRemaining = actor.weapon === "automatic" ? (actor.elite ? 5 : 4) : 1;
    return;
  }
  if (actor.burstRemaining > 0) {
    if (actor.burstCooldown > 0) return;
    if (!spawnProjectile(world, state, actor, actor.weapon === "pistol" ? 64 : 72)) { actor.burstRemaining = 0; return; }
    actor.burstRemaining -= 1;
    actor.burstCooldown = actor.weapon === "pistol" ? 0.28 : 0.15;
    if (actor.burstRemaining <= 0) actor.fireCooldown = actor.elite ? 1.45 : actor.weapon === "pistol" ? 1.15 : 1.8;
    return;
  }
  const range = actor.weapon === "pistol" ? 135 : 165;
  if (actor.fireCooldown <= 0 && metres <= range) {
    actor.aimRemaining = actor.elite ? 0.55 : actor.weapon === "pistol" ? 0.5 : 0.75;
    emit(world, "pursuer-aim", "", [actor.targetPlayer], {sourcePlayer: -1, gunnerId: actor.id, targetPlayer: actor.targetPlayer, eta: actor.aimRemaining, x: actor.x, y: actor.y});
  }
}

function segmentHit(from, to, target, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return distance(from, target) <= radius;
  const amount = clamp(((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(target.x - (from.x + dx * amount), target.y - (from.y + dy * amount)) <= radius;
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const next = {x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt};
    let hit = false;
    for (const boat of world.boats || []) {
      if (!boat || boat.sunk || !segmentHit(projectile, next, boat, 6.5)) continue;
      const damage = projectile.weapon === "pistol" ? 2 : 3;
      boat.hull = clamp(boat.hull - damage, 0.05, 100);
      boat.leak = clamp((Number(boat.leak) || 0) + damage * 0.04, 0, 16);
      const occupants = world.players.map((player, index) => ({player, index})).filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id).map(({index}) => index);
      emit(world, "enemy-bullet-boat-hit", `Пуля вражеского экипажа попала в лодку. Корпус ${Math.round(boat.hull)}.`, occupants.length ? occupants : [boat.owner], {sourcePlayer: -1, gunnerId: projectile.actorId, targetBoat: boat.id, x: next.x, y: next.y});
      hit = true;
      break;
    }
    if (!hit) {
      for (let index = 0; index < world.players.length; index += 1) {
        const player = world.players[index];
        if (!world.freeActivities?.presence?.[index] || !player?.combat?.alive || !["foot", "swim", "roof"].includes(player.mode)) continue;
        if (!segmentHit(projectile, next, player, 1.9)) continue;
        helpers?.damagePlayer?.(world, index, projectile.weapon === "pistol" ? 5 : 4, {weapon: projectile.weapon, eventType: "gun-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}});
        hit = true;
        break;
      }
    }
    if (hit) continue;
    projectile.x = next.x;
    projectile.y = next.y;
    projectile.ttl -= dt;
    if (projectile.ttl > 0 && projectile.x >= -8 && projectile.x <= 428 && projectile.y >= -8 && projectile.y <= 328) survivors.push(projectile);
  }
  state.projectiles = survivors;
}

export function damageHostileActor(world, actorId, amount, sourcePlayer = -1, details = {}) {
  const actor = activeHostileActors(world).find(candidate => candidate.id === actorId);
  if (!actor || amount <= 0) return false;
  actor.health = clamp(actor.health - amount, 0, actor.maxHealth);
  emit(world, "hostile-actor-hit", `Попадание по ${actor.elite ? "элитному стрелку" : "вражескому бойцу"}. Осталось ${Math.round(actor.health)}.`, [sourcePlayer].filter(index => index >= 0), {sourcePlayer, actorId, weapon: details.weapon, damage: amount, health: actor.health, x: actor.x, y: actor.y});
  if (actor.health > 0) return true;
  actor.active = false;
  actor.destroyed = true;
  actor.state = "dead";
  actor.burstRemaining = 0;
  emit(world, actor.elite ? "elite-destroyed" : "hostile-actor-destroyed", actor.elite ? "Элитный стрелок повержен." : "Вражеский боец повержен.", [0, 1], {sourcePlayer, actorId, elite: actor.elite, x: actor.x, y: actor.y});
  return true;
}

export function releaseCrewFromBoat(world, boat) {
  for (const actor of activeHostileActors(world)) {
    if (actor.boatId !== boat.id || actor.state !== "aboard") continue;
    actor.state = "swim";
    actor.x = boat.x + actor.seatOffset;
    actor.y = boat.y;
    actor.strandedAt = world.time;
  }
}

export function updateHostileActors(world, dt, helpers = {}) {
  const state = ensureHostileActors(world);
  if (!state.active) return state;
  for (const actor of activeHostileActors(world)) {
    const beforeX = actor.x;
    const beforeY = actor.y;
    actor.stepCooldown = Math.max(0, (Number(actor.stepCooldown) || 0) - dt);
    updateMovement(world, actor, dt);
    const moved = Math.hypot(actor.x - beforeX, actor.y - beforeY);
    if (moved > 0.18 && actor.stepCooldown <= 0 && ["foot", "swim"].includes(actor.state)) {
      actor.stepCooldown = actor.elite ? 0.46 : actor.state === "swim" ? 0.78 : 0.62;
      emit(world, actor.state === "swim" ? "hostile-swim-step" : "hostile-footstep", "", [0, 1], {
        actorId: actor.id, elite: actor.elite, targetPlayer: actor.targetPlayer, x: actor.x, y: actor.y, heading: actor.heading,
      });
    }
    updateWeapon(world, state, actor, dt, helpers);
  }
  updateProjectiles(world, state, dt, helpers);
  if (!activeHostileActors(world).length) state.active = false;
  return state;
}
