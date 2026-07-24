"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export const ENEMY_BOAT_ROLES = Object.freeze(["observer", "rammer", "gunboat", "landing", "interceptor", "reserve"]);

function createBoat(id, role, x, y, heading, level) {
  const hull = level >= 4 ? 76 : 60;
  return {
    id,
    role,
    x,
    y,
    heading,
    speed: 0,
    hull,
    maxHull: hull,
    active: true,
    destroyed: false,
    targetPlayer: 0,
    contactCooldown: 1.5,
    fireCooldown: 1.2 + (Number(id.slice(-1)) || 0) * 0.3,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    crewSeats: level >= 4 && ["landing", "gunboat"].includes(role) ? 2 : 1,
    rewardDropped: false,
    assignmentReleased: false,
    destroyedAt: 0,
    hostile: role !== "observer",
    observeUntil: 0,
  };
}

export function ensureEnemyBoats(world) {
  world.freeEnemyBoats ||= {active: false, level: 0, boats: [], projectiles: [], nextProjectileId: 1};
  const state = world.freeEnemyBoats;
  state.boats ||= [];
  state.projectiles ||= [];
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  if (!Number.isFinite(state.level)) state.level = 0;
  if (typeof state.active !== "boolean") state.active = false;
  return state;
}

function activeStateBoats(world) {
  return ensureEnemyBoats(world).boats.filter(boat => boat.active && !boat.destroyed);
}

export function activeEnemyBoats(world) {
  return activeStateBoats(world).filter(boat => boat.hostile !== false);
}

export function enemyBoatById(world, id) {
  return activeEnemyBoats(world).find(boat => boat.id === id) || null;
}

export function startEnemyBoats(world, level, anchor = null) {
  const state = ensureEnemyBoats(world);
  state.level = Math.max(0, Math.min(5, Math.floor(Number(level) || 0)));
  state.active = state.level === 1 || state.level >= 3;
  state.projectiles = [];
  if (!state.active) {
    state.boats = [];
    return state;
  }
  const base = anchor || world.players?.[0] || {x: 210, y: 200};
  const roles = state.level === 1
    ? ["observer"]
    : state.level >= 4
      ? ["rammer", "rammer", "gunboat"]
      : ["interceptor"];
  if (state.level >= 5) {
    const coop = (world.freeActivities?.presence || []).filter(Boolean).length > 1;
    roles.splice(0, roles.length, ...(coop ? ["gunboat"] : []));
  }
  state.boats = roles.map((role, index) => {
    const side = index % 2 ? 1 : -1;
    const boat = createBoat(
      `threat-boat-${index + 1}`,
      role,
      clamp((base.x || 210) + side * (role === "observer" ? 118 : 75 + index * 18), 18, 402),
      clamp((base.y || 180) + (role === "observer" ? 40 : 82 + index * 14), 92, 302),
      side > 0 ? -35 : 35,
      state.level,
    );
    if (role === "observer") boat.observeUntil = world.time + 18;
    return boat;
  });
  emit(world, "enemy-reinforcements", state.level === 1
    ? "Разведывательный катер держится на расстоянии. Слышны мотор и короткие радиопередачи; огня не будет."
    : state.level >= 4
      ? "Угроза четыре из пяти. В бухту вошла ударная группа: таранщики и стрелковый катер."
      : "Угроза три из пяти. К преследователям присоединился катер-перехватчик.", [0, 1], {level: state.level});
  return state;
}

function actorForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
  return player;
}

function velocityForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return {x: 0, y: 0};
  if (["boat", "roof"].includes(player.mode)) {
    const boat = world.boats?.[player.activeBoat];
    const angle = (Number(boat?.heading) || 0) * Math.PI / 180;
    return {x: Math.sin(angle) * (Number(boat?.speed) || 0), y: -Math.cos(angle) * (Number(boat?.speed) || 0)};
  }
  return {x: 0, y: 0};
}

function desiredPoint(world, boat) {
  const player = actorForPlayer(world, boat.targetPlayer) || actorForPlayer(world, 0) || {x: 210, y: 180};
  const metres = distance(boat, player);
  if (boat.role === "observer") {
    const angle = bearing(player, boat) * Math.PI / 180;
    return {x: clamp(player.x + Math.sin(angle) * 125, 12, 408), y: clamp(player.y - Math.cos(angle) * 125, 82, 308)};
  }
  if (boat.role === "interceptor") {
    const velocity = velocityForPlayer(world, boat.targetPlayer);
    return {x: clamp(player.x + velocity.x * 4.5, 12, 408), y: clamp(player.y + velocity.y * 4.5, 82, 308)};
  }
  if (boat.role === "landing") return {x: clamp(player.x, 12, 408), y: 79};
  if (boat.role === "gunboat") {
    const angle = bearing(player, boat) * Math.PI / 180;
    const range = metres < 90 ? 118 : 105;
    return {x: clamp(player.x + Math.sin(angle) * range, 12, 408), y: clamp(player.y - Math.cos(angle) * range, 82, 308)};
  }
  if (boat.role === "reserve") {
    const heavy = world.freeHeavyPursuer?.boat;
    return heavy?.active ? {x: heavy.x + 32, y: heavy.y + 28} : {x: player.x + 55, y: player.y + 45};
  }
  return player;
}

function moveBoat(world, boat, dt) {
  const target = desiredPoint(world, boat);
  const metres = distance(boat, target);
  let desiredHeading = bearing(boat, target);
  if (boat.role === "gunboat" && metres < 45) desiredHeading = wrapDeg(desiredHeading + 180);
  const turnRate = boat.role === "rammer" ? 72 : boat.role === "interceptor" ? 92 : 64;
  boat.heading = wrapDeg(boat.heading + clamp(wrapDeg(desiredHeading - boat.heading), -turnRate * dt, turnRate * dt));
  const desiredSpeed = boat.role === "observer" ? (metres > 18 ? 8 : 3)
    : boat.role === "rammer" ? (metres > 45 ? 19 : 15)
    : boat.role === "interceptor" ? (metres > 55 ? 18 : 12)
      : boat.role === "landing" ? (metres > 20 ? 13 : 5)
        : boat.role === "reserve" ? 9
          : (metres > 115 ? 14 : metres < 80 ? 9 : 11);
  boat.speed += clamp(desiredSpeed - boat.speed, -10 * dt, 8 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp(boat.x + Math.sin(angle) * boat.speed * dt, 7, 413);
  boat.y = clamp(boat.y - Math.cos(angle) * boat.speed * dt, 78, 313);
}

function segmentHit(from, to, target, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return distance(from, target) <= radius;
  const amount = clamp(((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(target.x - (from.x + dx * amount), target.y - (from.y + dy * amount)) <= radius;
}

function spawnProjectile(world, state, boat) {
  const target = actorForPlayer(world, boat.targetPlayer);
  if (!target || state.projectiles.length >= 22) return;
  const angle = bearing(boat, target) * Math.PI / 180;
  state.projectiles.push({
    id: `threat-bullet-${state.nextProjectileId++}`,
    boatId: boat.id,
    targetPlayer: boat.targetPlayer,
    x: boat.x,
    y: boat.y,
    sourceX: boat.x,
    sourceY: boat.y,
    vx: Math.sin(angle) * 70,
    vy: -Math.cos(angle) * 70,
    ttl: 5.2,
  });
  emit(world, "enemy-gun-shot", "", [0, 1], {sourcePlayer: -1, sourcePursuerId: boat.id, targetPlayer: boat.targetPlayer, x: boat.x, y: boat.y, heading: boat.heading});
}

function updateWeapon(world, state, boat, dt) {
  if (!["gunboat", "interceptor"].includes(boat.role)) return;
  const target = actorForPlayer(world, boat.targetPlayer);
  if (!target) return;
  const metres = distance(boat, target);
  boat.fireCooldown = Math.max(0, boat.fireCooldown - dt);
  boat.burstCooldown = Math.max(0, boat.burstCooldown - dt);
  if (boat.aimRemaining > 0) {
    boat.aimRemaining = Math.max(0, boat.aimRemaining - dt);
    if (boat.aimRemaining <= 0) boat.burstRemaining = boat.role === "gunboat" ? 5 : 3;
    return;
  }
  if (boat.burstRemaining > 0) {
    if (boat.burstCooldown > 0) return;
    spawnProjectile(world, state, boat);
    boat.burstRemaining -= 1;
    boat.burstCooldown = 0.15;
    if (boat.burstRemaining <= 0) boat.fireCooldown = boat.role === "gunboat" ? 2.1 : 2.8;
    return;
  }
  if (boat.fireCooldown > 0 || metres > 240) return;
  boat.aimRemaining = 0.75;
  emit(world, "pursuer-aim", "", [boat.targetPlayer], {sourcePlayer: -1, sourcePursuerId: boat.id, targetPlayer: boat.targetPlayer, eta: boat.aimRemaining, x: boat.x, y: boat.y});
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const next = {x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt};
    let hit = false;
    for (const boat of world.boats || []) {
      if (!boat || boat.sunk || !segmentHit(projectile, next, boat, 6.4)) continue;
      boat.hull = clamp(boat.hull - 2.5, 0.05, 100);
      boat.leak = clamp((Number(boat.leak) || 0) + 0.1, 0, 16);
      const occupants = world.players.map((player, index) => ({player, index})).filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id).map(({index}) => index);
      emit(world, "enemy-bullet-boat-hit", `Огонь ударной группы попал в лодку. Корпус ${Math.round(boat.hull)}.`, occupants.length ? occupants : [boat.owner], {sourcePlayer: -1, sourcePursuerId: projectile.boatId, targetBoat: boat.id, x: next.x, y: next.y});
      hit = true;
      break;
    }
    if (!hit) {
      for (let index = 0; index < world.players.length; index += 1) {
        const player = world.players[index];
        if (!world.freeActivities?.presence?.[index] || !player?.combat?.alive || !["foot", "swim", "roof"].includes(player.mode)) continue;
        if (!segmentHit(projectile, next, player, 1.9)) continue;
        helpers?.damagePlayer?.(world, index, 4, {weapon: "automatic", eventType: "gun-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}});
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

function updateRamming(world, boat, dt) {
  boat.contactCooldown = Math.max(0, boat.contactCooldown - dt);
  if (boat.role !== "rammer" || boat.contactCooldown > 0) return;
  for (const targetBoat of world.boats || []) {
    if (!targetBoat || targetBoat.sunk || distance(boat, targetBoat) > 12.2) continue;
    const impact = Math.max(8, boat.speed * 1.35);
    targetBoat.hull = clamp(targetBoat.hull - impact * 0.45, 0.05, 100);
    targetBoat.leak = clamp((Number(targetBoat.leak) || 0) + impact * 0.04, 0, 16);
    targetBoat.speed *= 0.45;
    boat.speed *= 0.55;
    boat.contactCooldown = 2.8;
    const occupants = world.players.map((player, index) => ({player, index})).filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === targetBoat.id).map(({index}) => index);
    emit(world, "enemy-ram-hit", `Таранщик ударил лодку. Корпус ${Math.round(targetBoat.hull)}.`, occupants.length ? occupants : [targetBoat.owner], {sourcePlayer: -1, sourcePursuerId: boat.id, targetBoat: targetBoat.id, x: targetBoat.x, y: targetBoat.y});
    break;
  }
}

export function damageEnemyBoat(world, boatId, amount, sourcePlayer = -1, helpers = {}, details = {}) {
  const boat = activeEnemyBoats(world).find(candidate => candidate.id === boatId);
  if (!boat || amount <= 0) return false;
  boat.hull = clamp(boat.hull - amount, 0, boat.maxHull || 60);
  emit(world, "enemy-boat-hit", `Попадание по ${boat.role === "rammer" ? "таранщику" : "вражескому катеру"}. Корпус ${Math.round(boat.hull)}.`, [sourcePlayer].filter(index => index >= 0), {sourcePlayer, sourcePursuerId: boat.id, damage: amount, hull: boat.hull, weapon: details.weapon, x: boat.x, y: boat.y});
  if (boat.hull > 0) return true;
  boat.active = false;
  boat.destroyed = true;
  boat.speed = 0;
  boat.destroyedAt = world.time;
  emit(world, "enemy-boat-destroyed", "Вражеский катер уничтожен. Экипаж оказался в воде.", [0, 1], {sourcePlayer, sourcePursuerId: boat.id, role: boat.role, x: boat.x, y: boat.y});
  helpers?.onEnemyBoatDestroyed?.(world, boat, sourcePlayer);
  return true;
}

export function updateEnemyBoats(world, dt, helpers = {}) {
  const state = ensureEnemyBoats(world);
  if (!state.active) return state;
  for (const boat of activeStateBoats(world)) {
    if (boat.role === "observer" && world.time >= boat.observeUntil) {
      boat.active = false;
      boat.speed = 0;
      emit(world, "observer-departed", "Разведывательный катер завершил наблюдение и ушёл из бухты.", [0, 1], {x: boat.x, y: boat.y});
      continue;
    }
    moveBoat(world, boat, dt);
    updateRamming(world, boat, dt);
    updateWeapon(world, state, boat, dt);
  }
  updateProjectiles(world, state, dt, helpers);
  if (!activeStateBoats(world).length) state.active = false;
  return state;
}
