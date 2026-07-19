"use strict";

export const PURSUER_SQUAD_TUNING = Object.freeze({
  range: 455,
  bulletSpeed: 64,
  aimSeconds: 0.65,
  playerDamage: 8,
  boatDamage: 4,
  maxProjectiles: 10,
  projectileSeconds: 7.4,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

function presentPlayers(world) {
  const presence = world.freeActivities?.presence || [];
  return world.players
    .map((player, index) => ({player, index}))
    .filter(({player, index}) => presence[index] && player?.combat?.alive);
}

function eventTargets(world) {
  return presentPlayers(world).map(({index}) => index);
}

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function createEscort(id, x, y, heading, fireCooldown) {
  return {
    id,
    x,
    y,
    heading,
    speed: 0,
    hull: 48,
    maxHull: 48,
    active: true,
    destroyed: false,
    targetPlayer: 0,
    fireCooldown,
    aimRemaining: 0,
    contactCooldown: 0,
    rewardDropped: false,
  };
}

export function ensurePursuerSquad(world) {
  world.freePursuerSquad ||= {
    activated: false,
    seed: 0x671a9d,
    nextProjectileId: 1,
    primaryWeapon: {targetPlayer: 0, fireCooldown: 1.2, aimRemaining: 0},
    assignments: {},
    escorts: [],
    projectiles: [],
  };
  const state = world.freePursuerSquad;
  if (typeof state.activated !== "boolean") state.activated = false;
  if (!Number.isFinite(state.seed)) state.seed = 0x671a9d;
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  state.primaryWeapon ||= {targetPlayer: 0, fireCooldown: 1.2, aimRemaining: 0};
  state.assignments ||= {};
  state.escorts ||= [];
  state.projectiles ||= [];
  const primary = world.freeActivities?.marauder;
  if (primary) primary.id ||= "pursuer-1";
  return state;
}

export function activatePursuerSquad(world) {
  const state = ensurePursuerSquad(world);
  if (state.activated && state.escorts.length === 2) return state;
  const anchor = world.freeActivities?.marauder || {x: 330, y: 245, heading: 300};
  state.activated = true;
  state.primaryWeapon = {targetPlayer: 0, fireCooldown: 1.2, aimRemaining: 0};
  state.assignments = {};
  state.escorts = [
    createEscort(
      "pursuer-2",
      clamp(anchor.x - 34, 12, 408),
      clamp(anchor.y + 24, 82, 308),
      wrapDeg(anchor.heading + 18),
      2.1,
    ),
    createEscort(
      "pursuer-3",
      clamp(anchor.x + 34, 12, 408),
      clamp(anchor.y - 24, 82, 308),
      wrapDeg(anchor.heading - 18),
      3,
    ),
  ];
  state.projectiles = [];
  return state;
}

export function activePursuers(world) {
  const state = ensurePursuerSquad(world);
  const active = [];
  const primary = world.freeActivities?.marauder;
  if (primary?.active && !primary.destroyed) active.push(primary);
  if (state.activated) {
    for (const escort of state.escorts) {
      if (escort.active && !escort.destroyed) active.push(escort);
    }
  }
  return active;
}

export function activePursuerById(world, pursuerId) {
  return activePursuers(world).find(pursuer => pursuer.id === pursuerId) || null;
}

export function assignedPursuerForPlayer(world, playerIndex) {
  const state = ensurePursuerSquad(world);
  const pursuerId = Object.entries(state.assignments)
    .find(([, assignedPlayer]) => assignedPlayer === playerIndex)?.[0];
  return activePursuerById(world, pursuerId);
}

export function nearestActivePursuer(world, point) {
  let result = null;
  let best = Infinity;
  for (const pursuer of activePursuers(world)) {
    const metres = distance(point, pursuer);
    if (metres >= best) continue;
    best = metres;
    result = pursuer;
  }
  return result;
}

export function isPursuerSquadDefeated(world) {
  const state = ensurePursuerSquad(world);
  if (!state.activated) return Boolean(world.freeActivities?.marauder?.destroyed);
  return activePursuers(world).length === 0;
}

function nextRandom(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

function actorForPlayer(world, playerIndex) {
  const player = world.players[playerIndex];
  if (["boat", "roof"].includes(player?.mode)) {
    return world.boats[player.activeBoat] || player;
  }
  return player;
}

function velocityForPlayer(world, playerIndex) {
  const player = world.players[playerIndex];
  if (["boat", "roof"].includes(player?.mode)) {
    const boat = world.boats[player.activeBoat];
    if (!boat) return {x: 0, y: 0};
    const angle = (Number(boat.heading) || 0) * Math.PI / 180;
    return {
      x: Math.sin(angle) * (Number(boat.speed) || 0),
      y: -Math.cos(angle) * (Number(boat.speed) || 0),
    };
  }
  const input = world.inputs?.[playerIndex] || {};
  let x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let y = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const length = Math.hypot(x, y) || 1;
  const speed = player?.mode === "swim" ? 6 : input.run ? 12.5 : 8;
  return {x: x / length * speed, y: y / length * speed};
}

function assignedTarget(world, playerIndex, shooter) {
  const candidate = presentPlayers(world).find(item => item.index === playerIndex);
  if (!candidate) return null;
  const actor = actorForPlayer(world, candidate.index);
  return {...candidate, actor, distance: distance(shooter, actor)};
}

function reconcileAssignments(world, state) {
  const pursuers = activePursuers(world);
  const livePlayers = presentPlayers(world).map(({index}) => index);
  const livePlayerSet = new Set(livePlayers);
  const coveredPlayers = new Set();
  const next = {};

  for (const pursuer of pursuers) {
    const playerIndex = state.assignments[pursuer.id];
    if (!livePlayerSet.has(playerIndex) || coveredPlayers.has(playerIndex)) continue;
    next[pursuer.id] = playerIndex;
    coveredPlayers.add(playerIndex);
  }

  const waitingPlayers = livePlayers.filter(index => !coveredPlayers.has(index));
  for (const pursuer of pursuers) {
    if (Number.isInteger(next[pursuer.id]) || !waitingPlayers.length) continue;
    const playerIndex = waitingPlayers.shift();
    next[pursuer.id] = playerIndex;
    emit(
      world,
      "pursuer-target-lock",
      "Катер-преследователь выбрал тебя. Только его двойной низкий сигнал предупреждает о выстреле по тебе.",
      [playerIndex],
      {
        sourcePlayer: -1,
        sourcePursuerId: pursuer.id,
        targetPlayer: playerIndex,
        x: pursuer.x,
        y: pursuer.y,
      },
    );
  }
  state.assignments = next;
}

function moveEscort(world, escort, dt, playerIndex) {
  let target = assignedTarget(world, playerIndex, escort);
  const reserve = !target;
  if (reserve) {
    const primary = world.freeActivities?.marauder;
    if (primary?.active && !primary.destroyed) {
      const side = escort.id === "pursuer-2" ? -1 : 1;
      const actor = {x: primary.x + side * 24, y: primary.y + 30};
      target = {actor, distance: distance(escort, actor)};
    }
  }
  if (!target) {
    escort.speed *= Math.max(0, 1 - dt * 2);
    return;
  }
  if (!reserve) escort.targetPlayer = playerIndex;
  const flank = escort.id === "pursuer-2" ? -1 : 1;
  let desired = bearing(escort, target.actor);
  if (!reserve && target.distance < 62) desired = wrapDeg(desired + 180);
  else if (!reserve && target.distance < 130) desired = wrapDeg(desired + flank * 68);
  const turn = clamp(wrapDeg(desired - escort.heading), -74 * dt, 74 * dt);
  escort.heading = wrapDeg(escort.heading + turn);
  const desiredSpeed = reserve
    ? target.distance > 42 ? 10 : target.distance < 18 ? 5 : 7
    : target.distance > 145 ? 15 : target.distance < 58 ? 13.5 : 11.5;
  escort.speed += clamp(desiredSpeed - escort.speed, -10 * dt, 8 * dt);
  const angle = escort.heading * Math.PI / 180;
  escort.x = clamp(escort.x + Math.sin(angle) * escort.speed * dt, 7, 413);
  escort.y = clamp(escort.y - Math.cos(angle) * escort.speed * dt, 78, 313);
}

function separateEscortFromBoats(world, escort, helpers) {
  for (const boat of world.boats || []) {
    if (!boat || boat.sunk) continue;
    let dx = escort.x - boat.x;
    let dy = escort.y - boat.y;
    let metres = Math.hypot(dx, dy);
    const minimum = 13.4;
    if (metres >= minimum) continue;
    if (metres < 0.001) {
      const angle = escort.heading * Math.PI / 180;
      dx = Math.sin(angle) || 1;
      dy = -Math.cos(angle);
      metres = 1;
    }
    const overlap = minimum - metres;
    const nx = dx / metres;
    const ny = dy / metres;
    const playerIndex = boat.driver ?? boat.owner;
    const effectiveHeading = wrapDeg(boat.heading + (boat.speed < 0 ? 180 : 0));
    const directedAtEscort = Math.abs(wrapDeg(bearing(boat, escort) - effectiveHeading)) <= 70;
    let rammed = false;
    if (escort.contactCooldown <= 0 && Math.abs(boat.speed) >= 4.5 && directedAtEscort) {
      const impact = Math.max(9, Math.abs(boat.speed) * 1.65);
      rammed = damageEscort(world, escort.id, impact, playerIndex, helpers, {weapon: "ram"});
      if (rammed) escort.contactCooldown = 1.2;
      boat.hull = clamp(boat.hull - impact * 0.24, 0.05, 100);
      boat.leak = clamp((Number(boat.leak) || 0) + impact * 0.025, 0, 16);
    }
    boat.x = clamp(boat.x - nx * overlap * 0.32, 7, 413);
    boat.y = clamp(boat.y - ny * overlap * 0.32, 78, 313);
    escort.x = clamp(escort.x + nx * overlap * 0.68, 7, 413);
    escort.y = clamp(escort.y + ny * overlap * 0.68, 78, 313);
    boat.speed *= 0.52;
    escort.heading = bearing(boat, escort);
    escort.speed = Math.max(8, Math.abs(escort.speed) * 0.48);
    if (escort.contactCooldown > 0 || rammed || escort.destroyed) continue;
    escort.contactCooldown = 1.2;
    const occupants = world.players
      .map((player, index) => ({player, index}))
      .filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id)
      .map(({index}) => index);
    emit(world, "escort-contact", "Катер-преследователь упёрся в лодку и отходит.", occupants, {
      sourcePlayer: -1,
      sourcePursuerId: escort.id,
      targetBoat: boat.id,
      x: (boat.x + escort.x) / 2,
      y: (boat.y + escort.y) / 2,
    });
  }
}

function spawnProjectile(world, state, shooter, weapon) {
  if (state.projectiles.length >= PURSUER_SQUAD_TUNING.maxProjectiles) return false;
  const targetPlayer = presentPlayers(world).find(candidate => candidate.index === weapon.targetPlayer);
  if (!targetPlayer) return false;
  const actor = actorForPlayer(world, targetPlayer.index);
  const target = {...targetPlayer, actor, distance: distance(shooter, actor)};
  if (target.distance > PURSUER_SQUAD_TUNING.range) return false;
  const velocity = velocityForPlayer(world, target.index);
  const travel = Math.min(2.7, target.distance / PURSUER_SQUAD_TUNING.bulletSpeed);
  const predicted = {
    x: clamp(target.actor.x + velocity.x * travel * 0.72, 5, 415),
    y: clamp(target.actor.y + velocity.y * travel * 0.72, 5, 315),
  };
  const angle = bearing(shooter, predicted) * Math.PI / 180;
  const id = `enemy-bullet-${state.nextProjectileId++}`;
  const projectile = {
    id,
    sourcePursuerId: shooter.id,
    targetPlayer: target.index,
    sourceX: shooter.x,
    sourceY: shooter.y,
    x: shooter.x + Math.sin(angle) * 7,
    y: shooter.y - Math.cos(angle) * 7,
    vx: Math.sin(angle) * PURSUER_SQUAD_TUNING.bulletSpeed,
    vy: -Math.cos(angle) * PURSUER_SQUAD_TUNING.bulletSpeed,
    damage: PURSUER_SQUAD_TUNING.playerDamage,
    ttl: PURSUER_SQUAD_TUNING.projectileSeconds,
    nearMissAnnounced: Array.from({length: world.players.length}, () => false),
  };
  state.projectiles.push(projectile);
  emit(world, "enemy-gun-shot", "", eventTargets(world), {
    sourcePlayer: -1,
    sourcePursuerId: shooter.id,
    projectileId: id,
    targetPlayer: target.index,
    x: shooter.x,
    y: shooter.y,
    heading: bearing(shooter, predicted),
  });
  weapon.targetPlayer = target.index;
  return true;
}

function updateWeapon(world, state, shooter, weapon, dt, playerIndex) {
  const assigned = assignedTarget(world, playerIndex, shooter);
  if (!assigned) {
    weapon.aimRemaining = 0;
    weapon.fireCooldown = Math.max(Number(weapon.fireCooldown) || 0, 0.35);
    return;
  }
  weapon.targetPlayer = playerIndex;
  weapon.fireCooldown = Math.max(0, (Number(weapon.fireCooldown) || 0) - dt);
  if (weapon.aimRemaining > 0) {
    weapon.aimRemaining = Math.max(0, weapon.aimRemaining - dt);
    if (weapon.aimRemaining > 0) return;
    spawnProjectile(world, state, shooter, weapon);
    weapon.fireCooldown = 1.45 + nextRandom(state) * 0.7;
    return;
  }
  if (weapon.fireCooldown > 0) return;
  const target = assigned;
  if (!target || target.distance > PURSUER_SQUAD_TUNING.range) {
    weapon.fireCooldown = 0.35;
    return;
  }
  weapon.targetPlayer = target.index;
  weapon.aimRemaining = PURSUER_SQUAD_TUNING.aimSeconds;
  emit(world, "pursuer-aim", "", [target.index], {
    sourcePlayer: -1,
    sourcePursuerId: shooter.id,
    targetPlayer: target.index,
    eta: PURSUER_SQUAD_TUNING.aimSeconds,
    x: shooter.x,
    y: shooter.y,
  });
}

function segmentCircleHit(x1, y1, x2, y2, circle, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - circle.x;
  const fy = y1 - circle.y;
  const a = dx * dx + dy * dy;
  if (a < 0.000001) return Math.hypot(fx, fy) <= radius ? 0 : null;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  if (first >= 0 && first <= 1) return first;
  if (second >= 0 && second <= 1) return second;
  return null;
}

function segmentDistance(x1, y1, x2, y2, point) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 0
    ? 0
    : clamp(((point.x - x1) * dx + (point.y - y1) * dy) / lengthSquared, 0, 1);
  const x = x1 + dx * t;
  const y = y1 + dy * t;
  return {distance: Math.hypot(point.x - x, point.y - y), x, y};
}

function firstProjectileCollision(world, projectile, x2, y2) {
  let result = null;
  for (const boat of world.boats || []) {
    if (boat.sunk) continue;
    const time = segmentCircleHit(projectile.x, projectile.y, x2, y2, boat, 6.6);
    if (time == null || (result && time >= result.time)) continue;
    result = {kind: "boat", actor: boat, time};
  }
  for (const {player, index} of presentPlayers(world)) {
    if (!["foot", "swim"].includes(player.mode)) continue;
    const time = segmentCircleHit(projectile.x, projectile.y, x2, y2, player, 1.9);
    if (time == null || (result && time >= result.time)) continue;
    result = {kind: "player", actor: player, playerIndex: index, time};
  }
  return result;
}

function hitBoat(world, projectile, boat, x, y) {
  boat.hull = clamp(boat.hull - PURSUER_SQUAD_TUNING.boatDamage, 0.05, 100);
  boat.leak = clamp((Number(boat.leak) || 0) + 0.22, 0, 16);
  boat.speed *= 0.94;
  const occupants = world.players
    .map((player, index) => ({player, index}))
    .filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id)
    .map(({index}) => index);
  const targets = occupants.length ? occupants : [boat.driver ?? boat.owner].filter(Number.isInteger);
  const text = occupants.length
    ? `Пуля попала в твою лодку. Корпус ${Math.round(boat.hull)}.`
    : `Пуля попала в твою пустую лодку. Корпус ${Math.round(boat.hull)}.`;
  emit(world, "enemy-bullet-boat-hit", text, targets, {
    sourcePlayer: -1,
    sourcePursuerId: projectile.sourcePursuerId,
    projectileId: projectile.id,
    targetBoat: boat.id,
    damage: PURSUER_SQUAD_TUNING.boatDamage,
    hull: boat.hull,
    x,
    y,
  });
}

function announceNearMisses(world, projectile, x2, y2) {
  for (const {player, index} of presentPlayers(world)) {
    if (projectile.nearMissAnnounced[index]) continue;
    const actor = actorForPlayer(world, index);
    const near = segmentDistance(projectile.x, projectile.y, x2, y2, actor);
    if (near.distance <= 2.2 || near.distance > 9) continue;
    projectile.nearMissAnnounced[index] = true;
    emit(world, "enemy-bullet-near", "", [index], {
      sourcePlayer: -1,
      sourcePursuerId: projectile.sourcePursuerId,
      projectileId: projectile.id,
      targetPlayer: index,
      x: near.x,
      y: near.y,
    });
  }
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const x2 = projectile.x + projectile.vx * dt;
    const y2 = projectile.y + projectile.vy * dt;
    const collision = firstProjectileCollision(world, projectile, x2, y2);
    if (collision) {
      const x = projectile.x + (x2 - projectile.x) * collision.time;
      const y = projectile.y + (y2 - projectile.y) * collision.time;
      if (collision.kind === "boat") {
        hitBoat(world, projectile, collision.actor, x, y);
      } else if (helpers?.damagePlayer) {
        helpers.damagePlayer(world, collision.playerIndex, projectile.damage, {
          weapon: "automatic",
          eventType: "gun-hit",
          sourcePoint: {x: projectile.sourceX, y: projectile.sourceY},
        });
      } else {
        collision.actor.combat.pendingDamage += projectile.damage;
      }
      continue;
    }
    announceNearMisses(world, projectile, x2, y2);
    projectile.x = x2;
    projectile.y = y2;
    projectile.ttl -= dt;
    if (
      projectile.ttl > 0
      && projectile.x >= -8
      && projectile.x <= 428
      && projectile.y >= -8
      && projectile.y <= 328
    ) {
      survivors.push(projectile);
    }
  }
  state.projectiles = survivors;
}

export function damageEscort(world, pursuerId, amount, sourcePlayer, helpers = {}, details = {}) {
  const state = ensurePursuerSquad(world);
  const escort = state.escorts.find(candidate => candidate.id === pursuerId);
  if (!escort?.active || escort.destroyed || amount <= 0) return false;
  const rammed = details.weapon === "ram";
  escort.hull = clamp(escort.hull - amount, 0, escort.maxHull || 48);
  emit(world, "pursuer-hit", `${rammed ? "Таран попал" : "Попадание"}. Корпус катера ${Math.round(escort.hull)}.`, [sourcePlayer], {
    sourcePlayer,
    pursuerId: escort.id,
    weapon: details.weapon || "automatic",
    damage: amount,
    hull: escort.hull,
    x: escort.x,
    y: escort.y,
  });
  if (escort.hull > 0) return true;
  escort.active = false;
  escort.destroyed = true;
  escort.speed = 0;
  const remaining = activePursuers(world).length;
  emit(world, "pursuer-destroyed", `Катер уничтожен${rammed ? " тараном" : ""}. Осталось ${remaining}.`, eventTargets(world), {
    sourcePlayer,
    pursuerId: escort.id,
    weapon: details.weapon || "automatic",
    remaining,
    x: escort.x,
    y: escort.y,
  });
  if (!escort.rewardDropped && helpers?.spawnRareCrate) {
    escort.rewardDropped = true;
    const kind = escort.id === "pursuer-2" ? "ammo" : "plates";
    helpers.spawnRareCrate(world, escort.x, escort.y, kind, "pursuer");
  }
  return true;
}

export function updatePursuerSquad(world, dt, helpers = {}) {
  const state = ensurePursuerSquad(world);
  if (world.freeScenario?.phase === "pursuit" && !state.activated) activatePursuerSquad(world);
  if (!state.activated) return state;
  reconcileAssignments(world, state);
  for (const escort of state.escorts) {
    if (!escort.active || escort.destroyed) continue;
    escort.contactCooldown = Math.max(0, (Number(escort.contactCooldown) || 0) - dt);
    const targetPlayer = state.assignments[escort.id];
    moveEscort(world, escort, dt, targetPlayer);
    separateEscortFromBoats(world, escort, helpers);
    if (!escort.active || escort.destroyed) continue;
    updateWeapon(world, state, escort, escort, dt, targetPlayer);
  }
  const primary = world.freeActivities?.marauder;
  if (primary?.active && !primary.destroyed) {
    updateWeapon(world, state, primary, state.primaryWeapon, dt, state.assignments[primary.id]);
  }
  updateProjectiles(world, state, dt, helpers);
  return state;
}
