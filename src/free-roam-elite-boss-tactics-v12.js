"use strict";

export const ELITE_TACTICS_VERSION = "1.2.0";
export const ELITE_RESPAWN_GRACE_SECONDS = 2;
export const ELITE_TURRET_TACTICAL_SPEED = 148;
export const ELITE_COMMANDER_TACTICAL_SPEED = 96;

const BOUNDS = Object.freeze({minX: 5, maxX: 415, minY: 5, maxY: 313});
const BOAT_BOUNDS = Object.freeze({minX: 15, maxX: 405, minY: 84, maxY: 305});
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;
const headingVector = heading => ({
  x: Math.sin((Number(heading) || 0) * Math.PI / 180),
  y: -Math.cos((Number(heading) || 0) * Math.PI / 180),
});
const rightVector = heading => ({
  x: Math.cos((Number(heading) || 0) * Math.PI / 180),
  y: Math.sin((Number(heading) || 0) * Math.PI / 180),
});

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({
    type,
    text,
    targets,
    at: world.time,
    operationEvent: true,
    eliteTacticsVersion: ELITE_TACTICS_VERSION,
    ...extra,
  });
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function playerPoint(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function graceUntil(world, index) {
  return Number(world.freeThreatDirector?.graceUntil?.[index]) || 0;
}

export function eliteRespawnGraceActiveV12(world, index) {
  return graceUntil(world, index) > (Number(world.time) || 0);
}

function livingTargets(world) {
  return values(world.players).map((player, index) => ({player, index, point: playerPoint(world, index)}))
    .filter(({player, index, point}) => (
      world.freeActivities?.presence?.[index] !== false
      && player?.combat?.alive
      && point
      && !eliteRespawnGraceActiveV12(world, index)
    ));
}

function nearestTarget(world, source) {
  return livingTargets(world).sort((a, b) => distance(source, a.point) - distance(source, b.point))[0] || null;
}

function inferRequestTarget(world, request) {
  if (Number.isInteger(request?.targetPlayer)) return request.targetPlayer;
  const target = {x: Number(request?.targetX), y: Number(request?.targetY)};
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  const candidates = values(world.players).map((player, index) => ({index, point: playerPoint(world, index)}))
    .filter(item => item.point)
    .sort((a, b) => distance(target, a.point) - distance(target, b.point));
  return candidates[0] && distance(target, candidates[0].point) <= 62 ? candidates[0].index : null;
}

function ensureTactics(world) {
  world.freeEliteBossTacticsV12 ||= {
    version: ELITE_TACTICS_VERSION,
    boatMode: "orbit",
    boatModeUntil: 0,
    boatSide: 1,
    lastBombRunAt: -999,
    graceWindows: [],
    eliteProjectileIds: [],
    hostileProjectileIds: [],
    commander: {
      id: null,
      lastDurability: null,
      dodgeUntil: 0,
      retreatUntil: 0,
      side: 1,
      previousAim: 0,
      previousAttackCooldown: 0,
    },
  };
  const state = world.freeEliteBossTacticsV12;
  state.version = ELITE_TACTICS_VERSION;
  state.graceWindows = values(state.graceWindows);
  state.eliteProjectileIds = values(state.eliteProjectileIds).map(String);
  state.hostileProjectileIds = values(state.hostileProjectileIds).map(String);
  state.commander ||= {};
  return state;
}

function prepareRespawnGrace(world, tactics) {
  const boss = world.freeEliteBoatBoss;
  const hostile = world.freeHostileActors;
  for (let index = 0; index < values(world.players).length; index += 1) {
    if (!eliteRespawnGraceActiveV12(world, index)) continue;
    const until = graceUntil(world, index);
    const player = world.players[index];
    const combat = player?.combat;
    if (combat && Number(tactics.graceWindows[index]) !== until) {
      tactics.graceWindows[index] = until;
      combat.attackCooldown = 0;
      combat.pistolCooldown = 0;
      combat.megaBombCooldown = 0;
      emit(
        world,
        "elite-respawn-rearm-v12",
        "Две секунды защиты: оружие готово, элитные враги пока не могут тебя захватить.",
        [index],
        {sourcePlayer: index, graceUntil: until},
      );
    }
    if (boss) {
      boss.projectiles = values(boss.projectiles).filter(projectile => projectile?.targetPlayer !== index);
      boss.bombRequests = values(boss.bombRequests).filter(request => inferRequestTarget(world, request) !== index);
    }
    if (hostile) {
      hostile.projectiles = values(hostile.projectiles).filter(projectile => projectile?.targetPlayer !== index);
      for (const actor of values(hostile.actors)) {
        if (!actor?.commander || actor.targetPlayer !== index) continue;
        const remaining = Math.max(0, until - (Number(world.time) || 0));
        actor.aimRemaining = 0;
        actor.burstRemaining = 0;
        actor.windupRemaining = 0;
        actor.fireCooldown = Math.max(Number(actor.fireCooldown) || 0, remaining);
        actor.attackCooldown = Math.max(Number(actor.attackCooldown) || 0, remaining);
        actor.bombCooldown = Math.max(Number(actor.bombCooldown) || 0, remaining);
        actor.tacticalMode = "respawn-stand-off";
      }
    }
  }
}

function predictedPoint(point, seconds = 1.2) {
  const forward = headingVector(point?.heading);
  const speed = Number(point?.speed) || 0;
  return {
    x: clamp((Number(point?.x) || 0) + forward.x * speed * seconds, BOUNDS.minX, BOUNDS.maxX),
    y: clamp((Number(point?.y) || 0) + forward.y * speed * seconds, BOUNDS.minY, BOUNDS.maxY),
  };
}

function steer(thing, desiredHeading, maximumTurn) {
  thing.heading = wrapDeg((Number(thing.heading) || 0) + clamp(
    wrapDeg(desiredHeading - (Number(thing.heading) || 0)),
    -maximumTurn,
    maximumTurn,
  ));
}

function prepareBoatTactics(world, tactics, dt) {
  const boss = world.freeEliteBoatBoss;
  const boat = boss?.boat;
  if (!boss?.active || !boat?.alive || !["approaching", "boat-combat"].includes(boss.phase)) {
    tactics.boatMode = "orbit";
    return;
  }
  const target = nearestTarget(world, boat);
  if (!target) return;
  const now = Number(world.time) || 0;
  const metres = distance(boat, target.point);
  const bay = String(boss.bombBayState || boat.bombBayState || "closed");
  const reload = Math.max(0, Number(boss.bombCooldown) || 0);

  if (
    tactics.boatMode === "orbit"
    && bay === "closed"
    && reload <= 0.2
    && metres >= 72
    && metres <= 190
    && now - (Number(tactics.lastBombRunAt) || -999) >= 4.5
  ) {
    tactics.boatMode = "bomb-run";
    tactics.boatModeUntil = now + 3.2;
    tactics.boatSide = Number(tactics.boatSide) > 0 ? -1 : 1;
    tactics.lastBombRunAt = now;
    emit(
      world,
      "elite-bomb-run-v12",
      "Элитный катер дал полный газ и идёт на ближний бомбовый проход.",
      [target.index],
      {targetPlayer: target.index, side: tactics.boatSide, x: boat.x, y: boat.y},
    );
  }

  if (tactics.boatMode === "bomb-run") {
    const predicted = predictedPoint(target.point, 1.1);
    steer(boat, bearing(boat, predicted) + tactics.boatSide * 4, 176 * clamp(dt, 0, 0.1));
    boat.speed = clamp(Math.max(Number(boat.speed) || 0, 22.2), 0, 23);
    boat.movementMode = "close-bomb-run-v12";
    if (["opening", "open", "closing"].includes(bay) || metres < 54 || now >= tactics.boatModeUntil) {
      tactics.boatMode = "breakaway";
      tactics.boatModeUntil = now + 2.5;
    }
    return;
  }

  if (tactics.boatMode === "breakaway") {
    const away = bearing(target.point, boat) + tactics.boatSide * 58;
    steer(boat, away, 184 * clamp(dt, 0, 0.1));
    boat.speed = clamp(Math.max(Number(boat.speed) || 0, 22.5), 0, 23);
    boat.movementMode = "bomb-run-breakaway-v12";
    if (now >= tactics.boatModeUntil || metres > 145) tactics.boatMode = "orbit";
  }
}

function tuneEliteProjectile(world, boss, projectile) {
  const targetIndex = Number(projectile?.targetPlayer);
  if (!Number.isInteger(targetIndex) || eliteRespawnGraceActiveV12(world, targetIndex)) return false;
  const point = playerPoint(world, targetIndex);
  if (!point) return false;
  const targetForward = headingVector(point.heading);
  const targetRight = rightVector(point.heading);
  const travel = clamp(distance(projectile, point) / ELITE_TURRET_TACTICAL_SPEED, 0.04, 1.6);
  const targetSpeed = Number(point.speed) || 0;
  const serial = Number(String(projectile.id || "").match(/(\d+)$/)?.[1]) || 0;
  const sweep = ((serial % 5) - 2) * 0.72;
  const livingTurrets = values(boss?.boat?.turrets).filter(turret => !turret?.destroyed).length;
  const section = livingTurrets <= 1
    ? (serial % 2 ? 4.4 : -4.4)
    : projectile.aimSection === "rear" ? -4.6 : 4.6;
  const lane = (projectile.aimSection === "rear" ? -2.1 : 2.1) + sweep;
  const aim = {
    x: (Number(point.x) || 0) + targetForward.x * (targetSpeed * travel * 0.96 + section) + targetRight.x * lane,
    y: (Number(point.y) || 0) + targetForward.y * (targetSpeed * travel * 0.96 + section) + targetRight.y * lane,
  };
  const angle = bearing(projectile, aim) * Math.PI / 180;
  projectile.vx = Math.sin(angle) * ELITE_TURRET_TACTICAL_SPEED;
  projectile.vy = -Math.cos(angle) * ELITE_TURRET_TACTICAL_SPEED;
  projectile.tacticalCrossfireV12 = true;
  projectile.tacticalLane = Math.round(lane * 100) / 100;
  return true;
}

function commanderActor(world) {
  const id = world.freeEliteBoatBoss?.commanderId;
  return values(world.freeHostileActors?.actors).find(actor => actor?.id === id && actor.active && !actor.destroyed) || null;
}

function prepareCommander(world, tactics) {
  const actor = commanderActor(world);
  const state = tactics.commander;
  if (!actor) {
    state.id = null;
    state.lastDurability = null;
    return;
  }
  if (state.id !== actor.id) {
    state.id = actor.id;
    state.lastDurability = (Number(actor.health) || 0) + (Number(actor.armor) || 0);
    state.dodgeUntil = 0;
    state.retreatUntil = 0;
    state.side = 1;
  }
  const durability = (Number(actor.health) || 0) + (Number(actor.armor) || 0);
  if (state.lastDurability !== null && durability < state.lastDurability - 0.1) {
    state.side = Number(state.side) > 0 ? -1 : 1;
    state.dodgeUntil = Math.max(Number(state.dodgeUntil) || 0, (Number(world.time) || 0) + 0.9);
  }
  state.lastDurability = durability;
  state.previousAim = Number(actor.aimRemaining) || 0;
  state.previousAttackCooldown = Number(actor.attackCooldown) || 0;
}

function moveActor(actor, heading, speed, dt) {
  const vector = headingVector(heading);
  actor.heading = wrapDeg(heading);
  actor.x = clamp((Number(actor.x) || 0) + vector.x * speed * clamp(dt, 0, 0.1), BOUNDS.minX, BOUNDS.maxX);
  actor.y = clamp((Number(actor.y) || 0) + vector.y * speed * clamp(dt, 0, 0.1), BOUNDS.minY, BOUNDS.maxY);
}

function finishCommander(world, tactics, dt) {
  const actor = commanderActor(world);
  const state = tactics.commander;
  if (!actor) return;
  const targetIndex = Number(actor.targetPlayer);
  const target = Number.isInteger(targetIndex) ? playerPoint(world, targetIndex) : null;
  if (!target) return;
  const now = Number(world.time) || 0;
  const metres = distance(actor, target);

  if (eliteRespawnGraceActiveV12(world, targetIndex)) {
    moveActor(actor, bearing(target, actor), metres < 25 ? 8.5 : 2.5, dt);
    actor.tacticalMode = "respawn-stand-off";
  } else {
    const knifeJustLanded = state.previousAttackCooldown < 1 && Number(actor.attackCooldown) >= 1.7;
    if (knifeJustLanded) state.retreatUntil = now + 1.15;
    if (now < Number(state.retreatUntil || 0)) {
      moveActor(actor, bearing(target, actor) + state.side * 24, 10.8, dt);
      actor.tacticalMode = "knife-breakaway-v12";
    } else if (now < Number(state.dodgeUntil || 0)) {
      moveActor(actor, bearing(actor, target) + state.side * 90, 11.4, dt);
      actor.tacticalMode = "damage-dodge-v12";
    } else if (actor.state === "foot" && metres >= 12 && metres <= 42) {
      moveActor(actor, bearing(actor, target) + state.side * 82, 4.8, dt);
      actor.tacticalMode = "ranged-strafe-v12";
    } else {
      actor.tacticalMode = actor.state === "swim" ? "swim-pursuit" : "pressure";
    }
  }

  if (state.previousAim > 0 && Number(actor.aimRemaining) <= 0 && Number(actor.burstRemaining) > 0) {
    if (actor.weapon === "automatic") actor.burstRemaining = Math.max(Number(actor.burstRemaining) || 0, 8);
    else if (actor.weapon === "pistol") actor.burstRemaining = Math.max(Number(actor.burstRemaining) || 0, 2);
  }
}

function tuneCommanderProjectile(world, projectile) {
  const actor = commanderActor(world);
  if (!actor || projectile?.actorId !== actor.id) return false;
  const index = Number(projectile.targetPlayer);
  if (!Number.isInteger(index) || eliteRespawnGraceActiveV12(world, index)) return false;
  const target = playerPoint(world, index);
  if (!target) return false;
  const travel = clamp(distance(projectile, target) / ELITE_COMMANDER_TACTICAL_SPEED, 0.04, 1.8);
  const forward = headingVector(target.heading);
  const targetSpeed = Number(target.speed) || 0;
  const serial = Number(String(projectile.id || "").match(/(\d+)$/)?.[1]) || 0;
  const right = rightVector(target.heading);
  const lane = ((serial % 3) - 1) * 0.55;
  const aim = {
    x: (Number(target.x) || 0) + forward.x * targetSpeed * travel * 0.82 + right.x * lane,
    y: (Number(target.y) || 0) + forward.y * targetSpeed * travel * 0.82 + right.y * lane,
  };
  const angle = bearing(projectile, aim) * Math.PI / 180;
  projectile.vx = Math.sin(angle) * ELITE_COMMANDER_TACTICAL_SPEED;
  projectile.vy = -Math.cos(angle) * ELITE_COMMANDER_TACTICAL_SPEED;
  projectile.eliteCommanderLeadV12 = true;
  return true;
}

export function prepareEliteBossTacticsV12(world, dt = 0) {
  const tactics = ensureTactics(world);
  prepareRespawnGrace(world, tactics);
  prepareBoatTactics(world, tactics, dt);
  prepareCommander(world, tactics);
  tactics.eliteProjectileIds = values(world.freeEliteBoatBoss?.projectiles).map(projectile => String(projectile?.id || ""));
  tactics.hostileProjectileIds = values(world.freeHostileActors?.projectiles).map(projectile => String(projectile?.id || ""));
  return tactics;
}

export function finishEliteBossTacticsV12(world, dt = 0) {
  const tactics = ensureTactics(world);
  const knownElite = new Set(tactics.eliteProjectileIds);
  const boss = world.freeEliteBoatBoss;
  if (boss) {
    boss.projectiles = values(boss.projectiles).filter(projectile => {
      if (eliteRespawnGraceActiveV12(world, Number(projectile?.targetPlayer))) return false;
      if (!knownElite.has(String(projectile?.id || ""))) tuneEliteProjectile(world, boss, projectile);
      return true;
    });
    if (boss.boat?.alive) {
      if (tactics.boatMode === "bomb-run") boss.boat.movementMode = "close-bomb-run-v12";
      else if (tactics.boatMode === "breakaway") boss.boat.movementMode = "bomb-run-breakaway-v12";
      boss.boat.tacticsVersion = ELITE_TACTICS_VERSION;
      boss.boat.x = clamp(boss.boat.x, BOAT_BOUNDS.minX, BOAT_BOUNDS.maxX);
      boss.boat.y = clamp(boss.boat.y, BOAT_BOUNDS.minY, BOAT_BOUNDS.maxY);
    }
  }

  const knownHostile = new Set(tactics.hostileProjectileIds);
  const hostile = world.freeHostileActors;
  if (hostile) {
    hostile.projectiles = values(hostile.projectiles).filter(projectile => {
      if (eliteRespawnGraceActiveV12(world, Number(projectile?.targetPlayer))) return false;
      if (!knownHostile.has(String(projectile?.id || ""))) tuneCommanderProjectile(world, projectile);
      return true;
    });
  }
  finishCommander(world, tactics, dt);
  return tactics;
}
