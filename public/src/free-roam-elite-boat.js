"use strict";

import {addEliteCommander, hostileActorById} from "./free-roam-hostile-actors.js?v=3";

export const ELITE_BOSS_VERSION = "1.0.0";
export const ELITE_ARMOR_LAYER_HP = 1000;
export const ELITE_HULL_HP = 5000;
export const ELITE_TURRET_HP = 520;
export const ELITE_BULLET_SPEED = 132;
export const ELITE_MAX_SPEED = 19.5;

const ARMOR_IDS = Object.freeze(["outer", "middle", "inner"]);
const WORLD_BOUNDS = Object.freeze({minX: 15, maxX: 405, minY: 84, maxY: 305});
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
const headingVector = heading => ({x: Math.sin((Number(heading) || 0) * Math.PI / 180), y: -Math.cos((Number(heading) || 0) * Math.PI / 180)});

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, eliteBossVersion: ELITE_BOSS_VERSION, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function armorLayers() {
  return ARMOR_IDS.map((id, index) => ({
    id,
    hp: ELITE_ARMOR_LAYER_HP,
    maxHp: ELITE_ARMOR_LAYER_HP,
    state: index === 0 ? "active" : "protected",
    criticalAnnounced: false,
    destroyedAnnounced: false,
  }));
}

function createTurret(id, side) {
  return {
    id: `elite-turret-${id}`,
    side,
    hp: ELITE_TURRET_HP,
    maxHp: ELITE_TURRET_HP,
    state: "ready",
    destroyed: false,
    targetPlayer: null,
    heading: 0,
    windup: 0,
    burstRemaining: 0,
    shotCooldown: 0,
    fireCooldown: side === "port" ? 1.2 : 1.65,
  };
}

function defaultState() {
  return {
    version: ELITE_BOSS_VERSION,
    active: false,
    encounterId: 0,
    threatEncounterId: 0,
    phase: "inactive",
    stage: "armor-outer",
    startedAt: 0,
    completedAt: 0,
    completionAnnounced: false,
    rewardReady: false,
    boat: null,
    projectiles: [],
    nextProjectileId: 1,
    bombRequests: [],
    nextBombRequestId: 1,
    bombCooldown: 0,
    salvoRemaining: 0,
    salvoCooldown: 0,
    commanderId: null,
    commanderSpawned: false,
    deployRemaining: 0,
    cleanupReason: null,
  };
}

export function ensureEliteBoatBoss(world) {
  world.freeEliteBoatBoss ||= defaultState();
  const state = world.freeEliteBoatBoss;
  state.version = ELITE_BOSS_VERSION;
  if (!Array.isArray(state.projectiles)) state.projectiles = Object.values(state.projectiles || {});
  if (!Array.isArray(state.bombRequests)) state.bombRequests = Object.values(state.bombRequests || {});
  if (!Number.isFinite(Number(state.nextProjectileId))) state.nextProjectileId = 1;
  if (!Number.isFinite(Number(state.nextBombRequestId))) state.nextBombRequestId = 1;
  if (!Number.isFinite(Number(state.bombCooldown))) state.bombCooldown = 0;
  if (!Number.isFinite(Number(state.salvoRemaining))) state.salvoRemaining = 0;
  if (!Number.isFinite(Number(state.salvoCooldown))) state.salvoCooldown = 0;
  if (!Number.isFinite(Number(state.deployRemaining))) state.deployRemaining = 0;
  if (state.boat) {
    state.boat.armorLayers ||= armorLayers();
    state.boat.turrets ||= [createTurret("port", "port"), createTurret("starboard", "starboard")];
  }
  return state;
}

export function activeEliteBoatBoss(world) {
  const state = ensureEliteBoatBoss(world);
  return state.active && !["completed", "aborted", "inactive"].includes(state.phase) ? state : null;
}

export function eliteBossBoat(world) {
  const state = activeEliteBoatBoss(world);
  return state?.boat?.alive ? state.boat : null;
}

function livingPlayers(world) {
  return (world.players || []).map((player, index) => ({player, index}))
    .filter(({player, index}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive);
}

function playerPoint(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return (world.boats || []).find(boat => String(boat?.id) === String(player.activeBoat)) || world.boats?.[player.activeBoat] || player;
  }
  return player;
}

function nearestPlayer(world, source) {
  return livingPlayers(world)
    .map(item => ({...item, point: playerPoint(world, item.index)}))
    .filter(item => item.point)
    .sort((a, b) => distance(source, a.point) - distance(source, b.point))[0] || null;
}

function spawnPoint(anchor) {
  const leftSpace = clamp((Number(anchor?.x) || 210) - WORLD_BOUNDS.minX, 0, 999);
  const rightSpace = clamp(WORLD_BOUNDS.maxX - (Number(anchor?.x) || 210), 0, 999);
  const x = rightSpace >= leftSpace ? WORLD_BOUNDS.maxX - 4 : WORLD_BOUNDS.minX + 4;
  return {x, y: clamp((Number(anchor?.y) || 180) + 72, WORLD_BOUNDS.minY + 8, WORLD_BOUNDS.maxY - 8)};
}

export function startEliteBoatBoss(world, threatEncounterId, anchor = {x: 210, y: 180}, targetPlayer = 0) {
  let previous = ensureEliteBoatBoss(world);
  if (previous.active && previous.threatEncounterId === threatEncounterId && !["completed", "aborted"].includes(previous.phase)) return previous;
  if (previous.active || previous.commanderId || previous.projectiles.length || previous.bombRequests.length) {
    resetEliteBoatBoss(world, "superseded");
    previous = ensureEliteBoatBoss(world);
  }
  const point = spawnPoint(anchor);
  const sequence = Math.max(1, Number(previous.encounterId) || 0) + 1;
  const state = defaultState();
  state.active = true;
  state.encounterId = sequence;
  state.threatEncounterId = Number(threatEncounterId) || 0;
  state.phase = "approaching";
  state.stage = "armor-outer";
  state.startedAt = Number(world.time) || 0;
  state.boat = {
    id: `elite-boat-${state.threatEncounterId || sequence}`,
    role: "elite-boss",
    encounterId: sequence,
    x: point.x,
    y: point.y,
    heading: bearing(point, anchor),
    speed: 8,
    maxSpeed: ELITE_MAX_SPEED,
    alive: true,
    active: true,
    destroyed: false,
    targetPlayer,
    armorLayers: armorLayers(),
    activeArmorIndex: 0,
    hull: ELITE_HULL_HP,
    maxHull: ELITE_HULL_HP,
    hullState: "protected",
    turrets: [createTurret("port", "port"), createTurret("starboard", "starboard")],
    movementMode: "intercept",
    ramCooldown: 0,
  };
  world.freeEliteBoatBoss = state;
  emit(world, "elite-boss-approach", "После тяжёлого катера в бухту входит элитный корабль. Три слоя брони, две скорострельные установки и бомбоотсеки активны.", [0, 1], {
    encounterId: state.encounterId, threatEncounterId: state.threatEncounterId, x: point.x, y: point.y,
  });
  return state;
}

function clearEliteTargets(world) {
  const prefix = "elite-";
  for (const player of world.players || []) {
    const combat = player?.combat;
    if (!combat) continue;
    if (String(combat.lockedTargetId || "").startsWith(prefix)) combat.lockedTargetId = null;
    if (String(combat.lastTargetRequestId || "").startsWith(prefix)) combat.lastTargetRequestId = null;
  }
}

export function resetEliteBoatBoss(world, reason = "reset") {
  const state = ensureEliteBoatBoss(world);
  const commanderId = state.commanderId;
  if (commanderId && world.freeHostileActors) {
    world.freeHostileActors.actors = (world.freeHostileActors.actors || []).filter(actor => actor.id !== commanderId);
    world.freeHostileActors.projectiles = (world.freeHostileActors.projectiles || []).filter(projectile => projectile.actorId !== commanderId);
  }
  if (world.freeMegaBombs) {
    const encounterId = Number(state.encounterId) || 0;
    world.freeMegaBombs.projectiles = (world.freeMegaBombs.projectiles || []).filter(projectile => Number(projectile?.eliteBossEncounterId) !== encounterId);
  }
  clearEliteTargets(world);
  const nextId = Math.max(0, Number(state.encounterId) || 0);
  world.freeEliteBoatBoss = {...defaultState(), encounterId: nextId, cleanupReason: reason, phase: reason === "completed" ? "completed" : "inactive"};
  return world.freeEliteBoatBoss;
}

function activeArmor(boat) {
  return boat?.armorLayers?.[boat.activeArmorIndex] || null;
}

function stageForIndex(index) {
  return index >= ARMOR_IDS.length ? "hull-exposed" : `armor-${ARMOR_IDS[index]}`;
}

function updateArmorStates(boat) {
  for (let index = 0; index < boat.armorLayers.length; index += 1) {
    const layer = boat.armorLayers[index];
    if (layer.hp <= 0) layer.state = "destroyed";
    else if (index === boat.activeArmorIndex) layer.state = "active";
    else layer.state = index < boat.activeArmorIndex ? "destroyed" : "protected";
  }
}

function announceArmorDamage(world, state, layer, sourcePlayer) {
  if (layer.hp > layer.maxHp * 0.25 || layer.criticalAnnounced) return;
  layer.criticalAnnounced = true;
  const names = {outer: "Внешний", middle: "Средний", inner: "Внутренний"};
  emit(world, "elite-armor-critical", `${names[layer.id]} слой брони почти разрушен.`, [0, 1], {
    sourcePlayer, layerId: layer.id, hp: layer.hp, x: state.boat.x, y: state.boat.y,
  });
}

function transitionArmor(world, state, sourcePlayer) {
  const boat = state.boat;
  const destroyed = boat.armorLayers[boat.activeArmorIndex];
  if (!destroyed || destroyed.hp > 0 || destroyed.destroyedAnnounced) return;
  destroyed.destroyedAnnounced = true;
  const names = {outer: "Внешний", middle: "Средний", inner: "Внутренний"};
  emit(world, "elite-armor-destroyed", `${names[destroyed.id]} слой брони уничтожен.`, [0, 1], {
    sourcePlayer, layerId: destroyed.id, x: boat.x, y: boat.y,
  });
  boat.activeArmorIndex += 1;
  updateArmorStates(boat);
  state.stage = stageForIndex(boat.activeArmorIndex);
  if (boat.activeArmorIndex >= boat.armorLayers.length) {
    boat.hullState = "exposed";
    emit(world, "elite-hull-exposed", "Все три слоя брони уничтожены. Основной корпус элитного катера открыт.", [0, 1], {
      sourcePlayer, x: boat.x, y: boat.y,
    });
  } else {
    const next = activeArmor(boat);
    emit(world, "elite-armor-next", `Открыт следующий слой брони: ${next.id === "middle" ? "средний" : "внутренний"}.`, [0, 1], {
      sourcePlayer, layerId: next.id, x: boat.x, y: boat.y,
    });
  }
}

function turretByComponent(boat, component) {
  if (component === "turret-port") return boat.turrets.find(turret => turret.side === "port") || null;
  if (component === "turret-starboard") return boat.turrets.find(turret => turret.side === "starboard") || null;
  return null;
}

export function damageEliteBoatBoss(world, component, amount, sourcePlayer = -1, details = {}) {
  const state = activeEliteBoatBoss(world);
  const boat = state?.boat;
  const raw = Math.max(0, Number(amount) || 0);
  if (!boat?.alive || raw <= 0 || !["approaching", "boat-combat"].includes(state.phase)) return false;
  const weapon = String(details.weapon || "unknown");
  const audience = sourcePlayer >= 0 ? [sourcePlayer] : [0, 1];
  const turret = turretByComponent(boat, component);
  if (turret) {
    if (turret.destroyed) return false;
    const before = turret.hp;
    turret.hp = clamp(before - raw, 0, turret.maxHp);
    const applied = before - turret.hp;
    emit(world, "elite-turret-hit", "", audience, {
      sourcePlayer, component, turretId: turret.id, damage: applied, weapon, x: boat.x, y: boat.y,
    });
    if (turret.hp <= 0) {
      turret.destroyed = true;
      turret.state = "destroyed";
      turret.burstRemaining = 0;
      turret.windup = 0;
      emit(world, "elite-turret-destroyed", `${turret.side === "port" ? "Левая" : "Правая"} скорострельная установка уничтожена. Вторая продолжает бой.`, [0, 1], {
        sourcePlayer, component, turretId: turret.id, x: boat.x, y: boat.y,
      });
    }
    return true;
  }

  if (weapon === "pistol") {
    emit(world, "armoured-target", "Пистолет не пробивает броню или корпус элитного катера. Выбери установку, автомат или мега-бомбу.", audience, {
      sourcePlayer, component, x: boat.x, y: boat.y,
    });
    return false;
  }

  const layer = activeArmor(boat);
  if (layer) {
    if (component && component !== `armor-${layer.id}` && component !== "armor") {
      emit(world, "elite-target-protected", "Эта часть ещё закрыта текущим слоем брони.", audience, {
        sourcePlayer, component, activeLayer: layer.id, x: boat.x, y: boat.y,
      });
      return false;
    }
    const before = layer.hp;
    layer.hp = clamp(before - raw, 0, layer.maxHp);
    const applied = before - layer.hp;
    emit(world, "elite-armor-hit", "", audience, {
      sourcePlayer, layerId: layer.id, damage: applied, weapon, x: boat.x, y: boat.y,
    });
    announceArmorDamage(world, state, layer, sourcePlayer);
    transitionArmor(world, state, sourcePlayer);
    return true;
  }

  if (!["hull", "armor"].includes(component || "hull")) return false;
  const before = boat.hull;
  boat.hull = clamp(before - raw, 0, boat.maxHull);
  const applied = before - boat.hull;
  emit(world, "elite-hull-hit", "", audience, {
    sourcePlayer, component: "hull", damage: applied, weapon, x: boat.x, y: boat.y,
  });
  if (boat.hull > 0) return true;
  beginBoatDestruction(world, state, sourcePlayer);
  return true;
}

function beginBoatDestruction(world, state, sourcePlayer) {
  if (state.phase === "boat-destroying" || !state.boat?.alive) return;
  const boat = state.boat;
  boat.alive = false;
  boat.active = false;
  boat.destroyed = true;
  boat.speed = 0;
  for (const turret of boat.turrets) {
    turret.burstRemaining = 0;
    turret.windup = 0;
    if (!turret.destroyed) turret.state = "disabled-by-hull";
  }
  state.phase = "boat-destroying";
  state.deployRemaining = 1.6;
  state.salvoRemaining = 0;
  state.projectiles = [];
  state.bombRequests = [];
  clearEliteTargets(world);
  emit(world, "elite-boat-destroyed", "Корпус элитного катера уничтожен. Корабельные установки замолчали, но бой ещё не окончен: командир готовится покинуть обломок.", [0, 1], {
    sourcePlayer, encounterId: state.encounterId, x: boat.x, y: boat.y,
  });
}

function targetForTurret(world, boat, turret, ordinal) {
  const players = livingPlayers(world).map(item => ({...item, point: playerPoint(world, item.index)})).filter(item => item.point);
  if (!players.length) return null;
  players.sort((a, b) => distance(boat, a.point) - distance(boat, b.point));
  const selected = players.length > 1 ? players[ordinal % players.length] : players[0];
  turret.targetPlayer = selected.index;
  return selected;
}

function turretPoint(boat, turret) {
  const forward = headingVector(boat.heading);
  const right = {x: Math.cos(boat.heading * Math.PI / 180), y: Math.sin(boat.heading * Math.PI / 180)};
  const side = turret.side === "port" ? -1 : 1;
  return {x: boat.x + forward.x * 3.6 + right.x * side * 3.2, y: boat.y + forward.y * 3.6 + right.y * side * 3.2};
}

function spawnTurretBullet(world, state, boat, turret, target) {
  if (state.projectiles.length >= 96 || !target?.point) return false;
  const muzzle = turretPoint(boat, turret);
  const leadSeconds = clamp(distance(muzzle, target.point) / ELITE_BULLET_SPEED, 0, 1.35);
  const targetVelocity = ["boat", "roof"].includes(target.player?.mode)
    ? headingVector(target.point.heading) : {x: 0, y: 0};
  const predicted = {
    x: clamp(target.point.x + targetVelocity.x * (Number(target.point.speed) || 0) * leadSeconds * 0.72, 5, 415),
    y: clamp(target.point.y + targetVelocity.y * (Number(target.point.speed) || 0) * leadSeconds * 0.72, 5, 315),
  };
  const angle = bearing(muzzle, predicted) * Math.PI / 180;
  const id = `elite-bullet-${state.encounterId}-${state.nextProjectileId++}`;
  state.projectiles.push({
    id, turretId: turret.id, targetPlayer: target.index,
    x: muzzle.x, y: muzzle.y, sourceX: muzzle.x, sourceY: muzzle.y,
    vx: Math.sin(angle) * ELITE_BULLET_SPEED, vy: -Math.cos(angle) * ELITE_BULLET_SPEED,
    ttl: 3.6,
  });
  emit(world, "elite-turret-shot", "", [0, 1], {
    projectileId: id, turretId: turret.id, side: turret.side, targetPlayer: target.index,
    x: muzzle.x, y: muzzle.y, heading: turret.heading,
  });
  return true;
}

function updateTurrets(world, state, dt) {
  const boat = state.boat;
  boat.turrets.forEach((turret, ordinal) => {
    if (turret.destroyed || !boat.alive) return;
    turret.fireCooldown = Math.max(0, turret.fireCooldown - dt);
    turret.shotCooldown = Math.max(0, turret.shotCooldown - dt);
    const target = targetForTurret(world, boat, turret, ordinal);
    if (!target) {
      turret.burstRemaining = 0;
      turret.windup = 0;
      turret.state = "ready";
      return;
    }
    turret.heading = bearing(turretPoint(boat, turret), target.point);
    const metres = distance(boat, target.point);
    if (metres > 210 || metres < 18) {
      turret.burstRemaining = 0;
      turret.windup = 0;
      turret.state = "tracking";
      return;
    }
    if (turret.windup > 0) {
      turret.windup = Math.max(0, turret.windup - dt);
      turret.state = "spinning";
      if (turret.windup <= 0) {
        turret.burstRemaining = 14;
        turret.shotCooldown = 0;
        turret.state = "firing";
      }
      return;
    }
    if (turret.burstRemaining > 0) {
      turret.state = "firing";
      if (turret.shotCooldown > 0) return;
      if (!spawnTurretBullet(world, state, boat, turret, target)) {
        turret.burstRemaining = 0;
        turret.fireCooldown = 1;
        return;
      }
      turret.burstRemaining -= 1;
      turret.shotCooldown = 0.085;
      if (turret.burstRemaining <= 0) {
        turret.fireCooldown = turret.side === "port" ? 2.25 : 2.55;
        turret.state = "cooling";
        emit(world, "elite-turret-burst-end", "", [0, 1], {turretId: turret.id, side: turret.side, x: boat.x, y: boat.y});
      }
      return;
    }
    if (turret.fireCooldown <= 0) {
      turret.windup = 0.52;
      turret.state = "spinning";
      emit(world, "elite-turret-windup", `${turret.side === "port" ? "Левая" : "Правая"} установка раскручивается. Начинается плотная очередь.`, [target.index], {
        turretId: turret.id, side: turret.side, targetPlayer: target.index, eta: turret.windup, x: boat.x, y: boat.y,
      });
    }
  });
}

function segmentHit(from, to, target, radius) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return distance(from, target) <= radius;
  const t = clamp(((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(target.x - (from.x + dx * t), target.y - (from.y + dy * t)) <= radius;
}

function occupantsForBoat(world, boat) {
  const occupants = [];
  for (let index = 0; index < (world.players || []).length; index += 1) {
    const player = world.players[index];
    if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false) continue;
    if (String(player.activeBoat) === String(boat.id) || boat.driver === index || boat.owner === index && ["boat", "roof"].includes(player.mode)) occupants.push(index);
  }
  return [...new Set(occupants)];
}

function applyBoatPenetration(world, projectile, boat, helpers) {
  const oldHull = clamp(boat.hull, 0, 100);
  const ratio = oldHull / 100;
  const hullDamage = 2.8;
  boat.hull = clamp(oldHull - hullDamage, 0, 100);
  boat.leak = clamp((Number(boat.leak) || 0) + 0.12, 0, 24);
  const occupants = occupantsForBoat(world, boat);
  for (const index of occupants) {
    const player = world.players[index];
    const penetration = player.mode === "roof" ? 1 : clamp(0.18 + (1 - ratio) * 0.7, 0.18, 0.88);
    const humanDamage = 7.2 * penetration;
    helpers?.damagePlayer?.(world, index, humanDamage, {
      weapon: "elite-automatic", heavy: humanDamage >= 5.2, eventType: "elite-bullet-player-hit",
      sourcePoint: {x: projectile.sourceX, y: projectile.sourceY},
      announceHealth: false,
    });
    emit(world, "elite-bullet-penetration", "", [index], {
      projectileId: projectile.id, turretId: projectile.turretId, targetBoat: boat.id, targetPlayer: index,
      hullDamage, humanDamage, penetration, hull: boat.hull, health: player.combat?.health,
      x: boat.x, y: boat.y,
    });
  }
  if (!occupants.length) {
    emit(world, "elite-bullet-boat-hit", "", [boat.owner].filter(Number.isInteger), {
      projectileId: projectile.id, turretId: projectile.turretId, targetBoat: boat.id, hullDamage, hull: boat.hull, x: boat.x, y: boat.y,
    });
  }
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const next = {x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt};
    let hit = false;
    for (const boat of world.boats || []) {
      if (!boat || boat.sunk || !segmentHit(projectile, next, boat, 6.8)) continue;
      applyBoatPenetration(world, projectile, boat, helpers);
      hit = true;
      break;
    }
    if (hit) continue;
    for (let index = 0; index < (world.players || []).length; index += 1) {
      const player = world.players[index];
      if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false || !["foot", "swim", "roof"].includes(player.mode)) continue;
      if (!segmentHit(projectile, next, player, 1.9)) continue;
      helpers?.damagePlayer?.(world, index, 7.2, {weapon: "elite-automatic", heavy: true, eventType: "elite-bullet-player-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}, announceHealth: false});
      emit(world, "elite-bullet-direct-hit", "", [index], {
        projectileId: projectile.id, turretId: projectile.turretId, damage: 7.2, x: player.x, y: player.y,
      });
      hit = true;
      break;
    }
    if (hit) continue;
    projectile.x = next.x;
    projectile.y = next.y;
    projectile.ttl -= dt;
    if (projectile.ttl > 0 && projectile.x >= -10 && projectile.x <= 430 && projectile.y >= -10 && projectile.y <= 330) survivors.push(projectile);
  }
  state.projectiles = survivors;
}

function desiredMovement(world, boat) {
  const target = nearestPlayer(world, boat);
  if (!target?.point) return {point: boat, speed: 0, mode: "idle"};
  boat.targetPlayer = target.index;
  const targetVector = headingVector(target.point.heading);
  const predicted = {
    x: clamp(target.point.x + targetVector.x * (Number(target.point.speed) || 0) * 1.8, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX),
    y: clamp(target.point.y + targetVector.y * (Number(target.point.speed) || 0) * 1.8, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY),
  };
  const metres = distance(boat, target.point);
  if (metres > 150) return {point: predicted, speed: ELITE_MAX_SPEED, mode: "intercept"};
  if (metres < 72) {
    const away = headingVector(bearing(target.point, boat));
    return {point: {x: clamp(boat.x + away.x * 80, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(boat.y + away.y * 80, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: 17.5, mode: "break-away"};
  }
  const orbitHeading = bearing(target.point, boat) + (boat.x < target.point.x ? 72 : -72);
  const orbit = headingVector(orbitHeading);
  return {point: {x: clamp(target.point.x + orbit.x * 112, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(target.point.y + orbit.y * 112, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: 13.5, mode: "standoff"};
}

function updateMovement(world, state, dt) {
  const boat = state.boat;
  const desired = desiredMovement(world, boat);
  boat.movementMode = desired.mode;
  const wantedHeading = bearing(boat, desired.point);
  boat.heading = wrapDeg(boat.heading + clamp(wrapDeg(wantedHeading - boat.heading), -95 * dt, 95 * dt));
  boat.speed += clamp(desired.speed - boat.speed, -9 * dt, 7.5 * dt);
  const vector = headingVector(boat.heading);
  const before = {x: boat.x, y: boat.y};
  boat.x = clamp(boat.x + vector.x * boat.speed * dt, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX);
  boat.y = clamp(boat.y + vector.y * boat.speed * dt, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY);
  if (boat.x === before.x && boat.y === before.y) {
    boat.heading = wrapDeg(boat.heading + 110 * dt);
    boat.speed = Math.max(4, boat.speed * 0.7);
  }
  if (state.phase === "approaching") {
    const target = nearestPlayer(world, boat);
    if (target?.point && distance(boat, target.point) <= 175) {
      state.phase = "boat-combat";
      emit(world, "elite-boss-combat-start", "Элитный катер вошёл в боевую дистанцию. Активен внешний слой брони.", [0, 1], {
        encounterId: state.encounterId, x: boat.x, y: boat.y,
      });
    }
  }
}

function requestBomb(world, state, source, target, sourceType) {
  if (!source || !target) return false;
  const id = `elite-bomb-request-${state.encounterId}-${state.nextBombRequestId++}`;
  state.bombRequests.push({id, sourceType, sourceId: source.id, x: source.x, y: source.y, heading: bearing(source, target), targetX: target.x, targetY: target.y, createdAt: world.time});
  return true;
}

function updateBombSalvo(world, state, dt) {
  const boat = state.boat;
  state.bombCooldown = Math.max(0, state.bombCooldown - dt);
  state.salvoCooldown = Math.max(0, state.salvoCooldown - dt);
  if (!boat.alive || !["approaching", "boat-combat"].includes(state.phase)) return;
  if (state.salvoRemaining > 0) {
    if (state.salvoCooldown > 0) return;
    const target = nearestPlayer(world, boat);
    if (!target?.point) { state.salvoRemaining = 0; return; }
    if (requestBomb(world, state, boat, target.point, "elite-boat")) {
      state.salvoRemaining -= 1;
      state.salvoCooldown = 0.42;
      emit(world, "elite-bomb-launch", "", [0, 1], {sourceId: boat.id, targetPlayer: target.index, remainingInSalvo: state.salvoRemaining, x: boat.x, y: boat.y});
    }
    if (state.salvoRemaining <= 0) state.bombCooldown = 10.5;
    return;
  }
  if (state.bombCooldown > 0 || state.bombRequests.length > 2) return;
  const target = nearestPlayer(world, boat);
  if (!target?.point) return;
  const metres = distance(boat, target.point);
  if (metres < 45 || metres > 190) return;
  state.salvoRemaining = 3;
  state.salvoCooldown = 0;
  emit(world, "elite-bomb-salvo", "Бомбоотсеки открыты. Элитный катер запускает короткий залп из трёх физических бомб.", [target.index], {
    sourceId: boat.id, targetPlayer: target.index, count: 3, x: boat.x, y: boat.y,
  });
}

function deployCommander(world, state) {
  if (state.commanderSpawned) return;
  state.commanderSpawned = true;
  state.phase = "commander-deploying";
  const boat = state.boat;
  const target = nearestPlayer(world, boat)?.index ?? 0;
  const commander = addEliteCommander(world, {id: boat.id, x: boat.x, y: boat.y, heading: boat.heading}, target, state.encounterId);
  state.commanderId = commander.id;
  state.phase = "commander-combat";
  emit(world, "elite-commander-deployed", "Из уничтоженного корабля физически высадился элитный командир. У него автомат, пистолет, быстрый нож и ограниченный запас бомб.", [0, 1], {
    commanderId: commander.id, encounterId: state.encounterId, x: commander.x, y: commander.y,
  });
}

function updateDestruction(world, state, dt) {
  if (state.phase === "boat-destroying") {
    state.deployRemaining = Math.max(0, state.deployRemaining - dt);
    if (state.deployRemaining <= 0) deployCommander(world, state);
    return;
  }
  if (state.phase !== "commander-combat") return;
  const commander = hostileActorById(world, state.commanderId);
  if (commander) return;
  if (!state.completionAnnounced) {
    state.completionAnnounced = true;
    state.active = false;
    state.phase = "completed";
    state.completedAt = world.time;
    state.rewardReady = true;
    state.projectiles = [];
    state.bombRequests = [];
    clearEliteTargets(world);
    emit(world, "elite-boss-completed", "Элитный командир повержен. Текущая угроза полностью завершена.", [0, 1], {
      encounterId: state.encounterId, x: state.boat?.x, y: state.boat?.y,
    });
  }
}

export function updateEliteBoatBoss(world, dt, helpers = {}) {
  const state = ensureEliteBoatBoss(world);
  const seconds = clamp(dt, 0, 0.1);
  if (["boat-combat", "approaching"].includes(state.phase) && state.boat?.alive) {
    updateMovement(world, state, seconds);
    updateTurrets(world, state, seconds);
    updateProjectiles(world, state, seconds, helpers);
    updateBombSalvo(world, state, seconds);
  } else if (state.projectiles.length) state.projectiles = [];
  updateDestruction(world, state, seconds);
  return state;
}

export function eliteBossCombatTargets(world, attackerIndex) {
  const state = activeEliteBoatBoss(world);
  const boat = state?.boat;
  if (!boat?.alive || !["approaching", "boat-combat"].includes(state.phase)) return [];
  const targets = [];
  const layer = activeArmor(boat);
  if (layer) {
    targets.push({id: `elite-armor-${layer.id}`, kind: "eliteArmor", component: `armor-${layer.id}`, layerId: layer.id, point: boat,
      label: `элитный катер, ${layer.id === "outer" ? "внешний" : layer.id === "middle" ? "средний" : "внутренний"} слой брони`, assigned: boat.targetPlayer === attackerIndex});
  } else {
    targets.push({id: "elite-hull", kind: "eliteHull", component: "hull", point: boat, label: "элитный катер, открытый корпус", assigned: boat.targetPlayer === attackerIndex});
  }
  for (const turret of boat.turrets) {
    if (turret.destroyed) continue;
    targets.push({id: turret.id, kind: "eliteTurret", component: `turret-${turret.side}`, turretId: turret.id, point: boat,
      label: `элитный катер, ${turret.side === "port" ? "левая" : "правая"} скорострельная установка`, assigned: turret.targetPlayer === attackerIndex});
  }
  return targets;
}

export function eliteBossCompleted(world) {
  const state = ensureEliteBoatBoss(world);
  return state.phase === "completed" && state.rewardReady;
}

export function consumeEliteBossCompletion(world) {
  const state = ensureEliteBoatBoss(world);
  if (!eliteBossCompleted(world)) return false;
  state.rewardReady = false;
  return true;
}
