"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

const PROJECTILE_RANGES = Object.freeze({
  pursuer: 240,
  gunner: 175,
  hostilePistol: 145,
  hostileAutomatic: 185,
  enemyBoat: 235,
  heavy: 285,
});
const LEGACY_HEAVY_REPAIR_PHASES = new Set(["retreating", "repairing", "returning"]);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function actorForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
  return player;
}

function livingPlayers(world) {
  return (world.players || [])
    .map((player, index) => ({player, index, actor: actorForPlayer(world, index)}))
    .filter(({player, index, actor}) => world.freeActivities?.presence?.[index] && player?.combat?.alive && actor);
}

function ensureState(world) {
  world.freeCombatAiV164 ||= {
    seed: 0x164a11,
    memories: {},
    heavyEncounterId: null,
    heavy: null,
    frame: null,
  };
  const state = world.freeCombatAiV164;
  state.memories ||= {};
  if (!Number.isFinite(state.seed)) state.seed = 0x164a11;
  return state;
}

function hashUnit(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function memoryFor(state, id, point = null) {
  const key = String(id || "unknown");
  state.memories[key] ||= {
    x: Number(point?.x) || 210,
    y: Number(point?.y) || 180,
    anchorX: Number(point?.x) || 210,
    anchorY: Number(point?.y) || 180,
    targetPlayer: null,
    lastSeenAt: -999,
    patrolIndex: Math.floor(hashUnit(key) * 4),
    stepCooldown: 0,
  };
  return state.memories[key];
}

function rememberTarget(world, state, entity, playerIndex) {
  const point = actorForPlayer(world, playerIndex);
  if (!point) return memoryFor(state, entity.id, entity);
  const memory = memoryFor(state, entity.id, point);
  memory.x = Number(point.x) || 0;
  memory.y = Number(point.y) || 0;
  memory.anchorX = memory.x;
  memory.anchorY = memory.y;
  memory.targetPlayer = playerIndex;
  memory.lastSeenAt = Number(world.time) || 0;
  return memory;
}

function patrolPoint(memory, id, water = false) {
  const phase = memory.patrolIndex % 4;
  const radius = 12 + hashUnit(`${id}:${phase}`) * 14;
  const offsets = [[1, 0.35], [0.25, 1], [-1, -0.2], [-0.15, -1]][phase];
  return {
    x: clamp(memory.anchorX + offsets[0] * radius, 8, 412),
    y: clamp(memory.anchorY + offsets[1] * radius, water ? 82 : 6, water ? 310 : 70),
  };
}

function movePoint(entity, target, speed, dt, bounds = {yMin: 5, yMax: 313}) {
  const dx = target.x - entity.x;
  const dy = target.y - entity.y;
  const metres = Math.hypot(dx, dy);
  if (metres <= 0.001 || speed <= 0 || dt <= 0) return metres;
  entity.heading = bearing(entity, target);
  const step = Math.min(metres, speed * dt);
  entity.x = clamp(entity.x + dx / metres * step, 5, 415);
  entity.y = clamp(entity.y + dy / metres * step, bounds.yMin, bounds.yMax);
  return metres - step;
}

function searchActor(world, state, actor, dt) {
  if (!actor?.active || actor.destroyed || actor.state === "dead" || actor.state === "aboard" || actor.state === "boarding" || actor.state === "disembarking") return;
  const targetPlayer = Number.isInteger(actor.targetPlayer) ? actor.targetPlayer : 0;
  const player = world.players?.[targetPlayer];
  const memory = player?.combat?.alive
    ? rememberTarget(world, state, actor, targetPlayer)
    : memoryFor(state, actor.id, player || actor);
  if (!player?.combat?.alive && Number.isFinite(player?.x) && Number.isFinite(player?.y) && memory.lastSeenAt < (Number(world.time) || 0) - 0.01) {
    memory.x = player.x;
    memory.y = player.y;
    memory.anchorX = player.x;
    memory.anchorY = player.y;
    memory.targetPlayer = targetPlayer;
    memory.lastSeenAt = Number(world.time) || 0;
  }
  if (player?.combat?.alive) return;

  actor.targetPlayer = targetPlayer;
  actor.aimRemaining = 0;
  actor.burstRemaining = 0;
  actor.windupRemaining = 0;
  actor.fireCooldown = Math.max(Number(actor.fireCooldown) || 0, 0.8);
  actor.returning = false;

  const atSearchArea = distance(actor, memory) <= 5;
  const destination = atSearchArea ? patrolPoint(memory, actor.id, actor.state === "swim") : memory;
  const speed = actor.elite ? 11.5 : actor.state === "swim" ? 5.2 : 9.2;
  const remaining = movePoint(actor, destination, speed, dt, actor.state === "swim" ? {yMin: 5, yMax: 313} : {yMin: 5, yMax: 70});
  if (atSearchArea && remaining <= 2.5) memory.patrolIndex = (memory.patrolIndex + 1) % 4;

  memory.stepCooldown = Math.max(0, memory.stepCooldown - dt);
  if (speed > 0 && memory.stepCooldown <= 0) {
    memory.stepCooldown = actor.state === "swim" ? 0.8 : actor.elite ? 0.42 : 0.58;
    emit(world, actor.state === "swim" ? "hostile-swim-step" : "hostile-footstep", "", [0, 1], {
      actorId: actor.id,
      elite: Boolean(actor.elite),
      searching: true,
      targetPlayer,
      x: actor.x,
      y: actor.y,
      heading: actor.heading,
    });
  }
}

function activeThreatBoats(world) {
  const result = [];
  const add = boat => {
    if (boat?.active && !boat.destroyed && !result.includes(boat)) result.push(boat);
  };
  add(world.freeActivities?.marauder);
  for (const boat of world.freePursuerSquad?.escorts || []) add(boat);
  for (const boat of world.freeEnemyBoats?.boats || []) add(boat);
  add(world.freeHeavyPursuer?.boat);
  return result;
}

function boatSearchSpeed(boat) {
  if (boat.role === "heavy") return 11.5;
  if (boat.role === "rammer" || boat.role === "interceptor") return 19;
  if (boat.role === "gunboat") return 15;
  if (boat.role === "observer") return 10;
  return 16;
}

function searchBoat(world, state, boat, dt, heavyState) {
  if (!boat?.active || boat.destroyed) return;
  if (boat.role === "heavy" && heavyState && heavyState.phase !== "combat") return;
  const targetPlayer = Number.isInteger(boat.targetPlayer) ? boat.targetPlayer : Number(world.freePursuerSquad?.assignments?.[boat.id]) || 0;
  const player = world.players?.[targetPlayer];
  if (player?.combat?.alive) {
    rememberTarget(world, state, boat, targetPlayer);
    return;
  }
  const memory = memoryFor(state, boat.id, player || boat);
  if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
    memory.x = player.x;
    memory.y = player.y;
    memory.anchorX = player.x;
    memory.anchorY = Math.max(82, player.y);
    memory.targetPlayer = targetPlayer;
  }
  boat.targetPlayer = targetPlayer;
  if (boat.hotfixWeapon) {
    boat.hotfixWeapon.aimRemaining = 0;
    boat.hotfixWeapon.burstRemaining = 0;
    boat.hotfixWeapon.fireCooldown = Math.max(Number(boat.hotfixWeapon.fireCooldown) || 0, 0.8);
  }
  boat.aimRemaining = 0;
  boat.burstRemaining = 0;
  boat.fireCooldown = Math.max(Number(boat.fireCooldown) || 0, 0.8);

  const atSearchArea = distance(boat, memory) <= 9;
  const destination = atSearchArea ? patrolPoint(memory, boat.id, true) : {x: memory.x, y: Math.max(82, memory.y)};
  const desired = bearing(boat, destination);
  const turnRate = boat.role === "heavy" ? 30 : 82;
  boat.heading = wrapDeg(boat.heading + clamp(wrapDeg(desired - boat.heading), -turnRate * dt, turnRate * dt));
  const desiredSpeed = boatSearchSpeed(boat);
  boat.speed += clamp(desiredSpeed - (Number(boat.speed) || 0), -8 * dt, 10 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp(boat.x + Math.sin(angle) * boat.speed * dt, 7, 413);
  boat.y = clamp(boat.y - Math.cos(angle) * boat.speed * dt, 82, 313);
  if (atSearchArea && distance(boat, destination) <= 5) memory.patrolIndex = (memory.patrolIndex + 1) % 4;
}

function projectileGroups(world) {
  return [
    {items: world.freePursuerSquad?.projectiles, max: () => PROJECTILE_RANGES.pursuer},
    {items: world.freeHostileGunners?.projectiles, max: () => PROJECTILE_RANGES.gunner},
    {items: world.freeHostileActors?.projectiles, max: projectile => projectile.weapon === "pistol" ? PROJECTILE_RANGES.hostilePistol : PROJECTILE_RANGES.hostileAutomatic},
    {items: world.freeEnemyBoats?.projectiles, max: () => PROJECTILE_RANGES.enemyBoat},
    {items: world.freeHeavyPursuer?.projectiles, max: () => PROJECTILE_RANGES.heavy},
  ];
}

function trimProjectileRanges(world) {
  for (const group of projectileGroups(world)) {
    if (!Array.isArray(group.items)) continue;
    for (let index = group.items.length - 1; index >= 0; index -= 1) {
      const projectile = group.items[index];
      const source = {x: projectile.sourceX ?? projectile.x, y: projectile.sourceY ?? projectile.y};
      const maximum = group.max(projectile);
      if (distance(source, projectile) >= maximum || Number(projectile.ttl) <= 0) group.items.splice(index, 1);
    }
  }
}

function spreadEnemyProjectiles(world) {
  for (const group of projectileGroups(world)) {
    if (!Array.isArray(group.items)) continue;
    for (const projectile of group.items) {
      if (projectile.v164SpreadApplied) continue;
      projectile.v164SpreadApplied = true;
      const speed = Math.hypot(Number(projectile.vx) || 0, Number(projectile.vy) || 0);
      if (speed <= 0) continue;
      const maximum = group.max(projectile);
      const source = {x: projectile.sourceX ?? projectile.x, y: projectile.sourceY ?? projectile.y};
      const target = actorForPlayer(world, projectile.targetPlayer);
      const rangeFactor = clamp(distance(source, target || projectile) / maximum, 0, 1);
      const heavy = maximum === PROJECTILE_RANGES.heavy;
      const maxSpread = heavy ? 3.2 : 2 + rangeFactor * 5.5;
      const offset = (hashUnit(projectile.id) * 2 - 1) * maxSpread * Math.PI / 180;
      const angle = Math.atan2(projectile.vx, -projectile.vy) + offset;
      projectile.vx = Math.sin(angle) * speed;
      projectile.vy = -Math.cos(angle) * speed;
      projectile.aimErrorDegrees = offset * 180 / Math.PI;
    }
  }
}

function heavyEncounterId(world, boat) {
  return Number(world.freeThreatDirector?.encounterId) || Number(world.freeHeavyPursuer?.encounterId) || String(boat?.id || "heavy-pursuer");
}

function initializeHeavy(world, state, boat) {
  const encounterId = heavyEncounterId(world, boat);
  const spawnedNow = (world.events || []).some(event => event.type === "heavy-pursuer-arrived");
  const armourMax = Math.max(1, Number(boat.maxHull) || Number(boat.hull) || 700);
  state.heavyEncounterId = encounterId;
  state.heavy = {
    encounterId,
    phase: spawnedNow ? "approach" : "combat",
    armourBreached: false,
    armourMax,
    coreMax: armourMax >= 900 ? 340 : 260,
    repairPlates: 3,
    repairSystem: null,
    repairProgress: 0,
    repairQuarter: 0,
    destination: null,
    combatPoint: {x: clamp(Number(boat.x) || 330, 70, 350), y: clamp(Number(boat.y) || 230, 115, 285)},
    lastDamageAt: -999,
    actualTurretDisabled: Boolean(boat.turretDisabled),
    actualEngineDisabled: Boolean(boat.engineDisabled),
  };
  if (spawnedNow) {
    const target = state.heavy.combatPoint;
    boat.x = 412;
    boat.y = clamp(target.y + 48, 105, 300);
    boat.heading = bearing(boat, target);
    boat.turretHeading = boat.heading;
    boat.speed = 0;
    boat.burstRemaining = 0;
    boat.aimRemaining = 0;
    boat.fireCooldown = 999;
    boat.turretDisabled = true;
    if (world.freeHeavyPursuer) world.freeHeavyPursuer.projectiles = [];
    for (const event of world.events || []) {
      if (event.type !== "heavy-pursuer-arrived") continue;
      event.type = "heavy-pursuer-approaching";
      event.text = "Снаружи бухты появился тяжёлый катер. Он физически входит на максимальном ходу; двигатель слышен всё ближе.";
      event.x = boat.x;
      event.y = boat.y;
    }
  }
  return state.heavy;
}

function normalizeLegacyHeavyRepair(heavy) {
  if (!heavy || !LEGACY_HEAVY_REPAIR_PHASES.has(String(heavy.phase))) return false;
  heavy.phase = "combat";
  heavy.destination = null;
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  return true;
}

function ensureHeavy(world, state) {
  const boat = world.freeHeavyPursuer?.boat;
  if (!boat) {
    state.heavyEncounterId = null;
    state.heavy = null;
    return null;
  }
  const encounterId = heavyEncounterId(world, boat);
  if (!state.heavy || state.heavyEncounterId !== encounterId) return initializeHeavy(world, state, boat);
  const heavy = state.heavy;
  if (typeof heavy.armourBreached !== "boolean") heavy.armourBreached = false;
  if (!Number.isFinite(heavy.repairPlates)) heavy.repairPlates = 3;
  if (!Number.isFinite(heavy.lastDamageAt)) heavy.lastDamageAt = -999;
  normalizeLegacyHeavyRepair(heavy);
  return heavy;
}

function frameSnapshot(world, state) {
  const boat = world.freeHeavyPursuer?.boat;
  const heavy = ensureHeavy(world, state);
  state.frame = boat && heavy ? {
    eventStart: world.events?.length || 0,
    deadAssignments: {},
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    speed: boat.speed,
    hull: boat.hull,
    maxHull: boat.maxHull,
    engineHealth: boat.engineHealth,
    turretHealth: boat.turretHealth,
    engineDisabled: boat.engineDisabled,
    turretDisabled: boat.turretDisabled,
    active: boat.active,
    destroyed: boat.destroyed,
  } : {eventStart: world.events?.length || 0, deadAssignments: {}};

  trimProjectileRanges(world);

  if (!boat || !heavy) return;
  if (heavy.phase === "approach") {
    boat.burstRemaining = 0;
    boat.aimRemaining = 0;
    boat.fireCooldown = Math.max(Number(boat.fireCooldown) || 0, 999);
    boat.turretDisabled = true;
    state.frame.overridePosition = {x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed};
  }

  for (const actor of [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]) {
    const target = world.players?.[actor?.targetPlayer];
    if (!actor?.active || actor.destroyed || target?.combat?.alive) continue;
    state.frame.deadAssignments[String(actor.id)] = Number(actor.targetPlayer);
    actor.burstRemaining = 0;
    actor.aimRemaining = 0;
    actor.windupRemaining = 0;
    actor.fireCooldown = Math.max(Number(actor.fireCooldown) || 0, 999);
  }
}

function removeEventTypes(world, start, types) {
  const blocked = new Set(types);
  for (let index = (world.events?.length || 0) - 1; index >= start; index -= 1) {
    if (blocked.has(world.events[index]?.type)) world.events.splice(index, 1);
  }
}

function applyPistolToExposedHeavy(world, boat, heavy, events) {
  if (!heavy.armourBreached) return;
  for (const event of events) {
    if (event?.type !== "armoured-target" || event.weapon && event.weapon !== "pistol") continue;
    const component = event.component || "hull";
    const damage = component === "hull" ? 9 : 16;
    if (component === "engine") {
      boat.engineHealth = clamp((Number(boat.engineHealth) || 0) - damage, 0, Number(boat.maxEngineHealth) || 180);
      if (boat.engineHealth <= 0) boat.engineDisabled = true;
    } else if (component === "turret") {
      boat.turretHealth = clamp((Number(boat.turretHealth) || 0) - damage, 0, Number(boat.maxTurretHealth) || 240);
      if (boat.turretHealth <= 0) boat.turretDisabled = true;
    } else {
      boat.hull = clamp((Number(boat.hull) || 0) - damage, 0, Number(boat.maxHull) || heavy.coreMax);
    }
    event.type = "heavy-component-hit";
    event.text = component === "engine"
      ? `Пистолет попал в открытый двигатель. Прочность ${Math.round(boat.engineHealth)}.`
      : component === "turret"
        ? `Пистолет попал в открытую установку. Прочность ${Math.round(boat.turretHealth)}.`
        : `Пистолет попал в открытый внутренний корпус. Осталось ${Math.round(boat.hull)}.`;
    event.weapon = "pistol";
    heavy.lastDamageAt = Number(world.time) || 0;
  }
}

function reconcileHeavyDamage(world, state, boat, heavy, frame) {
  if (!frame || !boat) return;
  const newEvents = (world.events || []).slice(frame.eventStart || 0);
  const componentHit = newEvents.some(event => event.type === "heavy-component-hit" || event.type === "armoured-target");
  const rawEngineDelta = Math.max(0, (Number(frame.engineHealth) || 0) - (Number(boat.engineHealth) || 0));
  const rawTurretDelta = Math.max(0, (Number(frame.turretHealth) || 0) - (Number(boat.turretHealth) || 0));
  const rawHullDelta = Math.max(0, (Number(frame.hull) || 0) - (Number(boat.hull) || 0));
  const estimatedDamage = component => {
    const event = [...newEvents].reverse().find(candidate => candidate?.type === "heavy-component-hit" && candidate.component === component);
    if (!event) return 0;
    if (event.weapon === "automatic") return 12;
    if (event.weapon === "pistol") return 6;
    if (event.weapon === "ram") return Math.max(9, Number(event.damage) || 9);
    return Math.max(1, Number(event.damage) || 0);
  };
  const engineIncoming = Math.max(rawEngineDelta, estimatedDamage("engine"));
  const turretIncoming = Math.max(rawTurretDelta, estimatedDamage("turret"));
  if (componentHit || rawEngineDelta || rawTurretDelta || rawHullDelta) heavy.lastDamageAt = Number(world.time) || 0;

  if (!heavy.armourBreached) {
    if (engineIncoming > 0) {
      boat.engineHealth = clamp((Number(frame.engineHealth) || 0) - engineIncoming * 0.3, 0, Number(boat.maxEngineHealth) || 180);
      boat.engineDisabled = boat.engineHealth <= 0;
    }
    if (turretIncoming > 0) {
      boat.turretHealth = clamp((Number(frame.turretHealth) || 0) - turretIncoming * 0.3, 0, Number(boat.maxTurretHealth) || 240);
      boat.turretDisabled = boat.turretHealth <= 0;
    }
  } else {
    if (engineIncoming > 0) {
      boat.engineHealth = clamp((Number(frame.engineHealth) || 0) - engineIncoming * 2.5, 0, Number(boat.maxEngineHealth) || 180);
      boat.engineDisabled = boat.engineHealth <= 0;
    }
    if (turretIncoming > 0) {
      boat.turretHealth = clamp((Number(frame.turretHealth) || 0) - turretIncoming * 2.5, 0, Number(boat.maxTurretHealth) || 240);
      boat.turretDisabled = boat.turretHealth <= 0;
    }
    applyPistolToExposedHeavy(world, boat, heavy, newEvents);
  }

  const armourDestroyed = !heavy.armourBreached && (
    Number(boat.hull) <= 0 || boat.destroyed || newEvents.some(event => event.type === "heavy-pursuer-destroyed")
  );
  if (armourDestroyed) {
    removeEventTypes(world, frame.eventStart || 0, ["heavy-pursuer-destroyed"]);
    heavy.armourBreached = true;
    heavy.phase = "combat";
    heavy.repairSystem = null;
    heavy.repairProgress = 0;
    boat.active = true;
    boat.destroyed = false;
    if (world.freeHeavyPursuer) world.freeHeavyPursuer.active = true;
    boat.maxHull = heavy.coreMax;
    boat.hull = heavy.coreMax;
    boat.turretDisabled = boat.turretHealth <= 0;
    boat.engineDisabled = boat.engineHealth <= 0;
    emit(world, "heavy-armour-breached", `Броневой корпус тяжёлого катера сорван. Катер ещё жив: открыт внутренний корпус, двигатель и установка теперь получают усиленный урон.`, [0, 1], {
      x: boat.x,
      y: boat.y,
      core: boat.hull,
    });
  }

  if (heavy.armourBreached) {
    heavy.actualEngineDisabled = Boolean(boat.engineDisabled);
    heavy.actualTurretDisabled = Boolean(boat.turretDisabled);
    if (boat.hull <= 0 || boat.destroyed) return;
    if (boat.engineDisabled && boat.turretDisabled && !heavy.systemsDisabledAnnounced) {
      heavy.systemsDisabledAnnounced = true;
      emit(world, "heavy-systems-disabled", "Двигатель и установка тяжёлого катера уничтожены. Остался открытый внутренний корпус.", [0, 1], {x: boat.x, y: boat.y});
    } else if (!boat.engineDisabled || !boat.turretDisabled) {
      heavy.systemsDisabledAnnounced = false;
    }
    return;
  }

  heavy.actualEngineDisabled = (Number(boat.engineHealth) || 0) <= 0;
  heavy.actualTurretDisabled = (Number(boat.turretHealth) || 0) <= 0;
  // V164 no longer owns repair. V166+ is the only lifecycle allowed to react
  // to destroyed components, both before and after the armour is breached.
}

function moveHeavyOverride(boat, destination, desiredSpeed, dt) {
  const desired = bearing(boat, destination);
  boat.heading = wrapDeg(boat.heading + clamp(wrapDeg(desired - boat.heading), -32 * dt, 32 * dt));
  boat.speed += clamp(desiredSpeed - (Number(boat.speed) || 0), -6 * dt, 4 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp(boat.x + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp(boat.y - Math.cos(angle) * boat.speed * dt, 84, 306);
  return distance(boat, destination);
}

function updateHeavyBehaviour(world, state, boat, heavy, frame, dt) {
  if (!boat?.active || boat.destroyed || dt <= 0) return;
  if (frame?.overridePosition) Object.assign(boat, frame.overridePosition);

  if (heavy.phase !== "approach") return;
  const remaining = moveHeavyOverride(boat, heavy.combatPoint, 11.8, dt);
  boat.turretDisabled = true;
  boat.fireCooldown = 999;
  if (remaining <= 4) {
    boat.x = heavy.combatPoint.x;
    boat.y = heavy.combatPoint.y;
    boat.speed = 0;
    heavy.phase = "combat";
    boat.turretDisabled = heavy.actualTurretDisabled;
    boat.fireCooldown = 1.8;
    emit(world, "heavy-pursuer-arrived", "Тяжёлый катер физически вошёл в бухту, остановился на боевой позиции и разворачивает установку.", [0, 1], {x: boat.x, y: boat.y});
  }
}

function updateSearch(world, state, dt) {
  const living = livingPlayers(world);
  const heavy = state.heavy;
  const deadAssignments = state.frame?.deadAssignments || {};
  for (const actor of [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]) {
    const assigned = deadAssignments[String(actor?.id)];
    if (Number.isInteger(assigned)) actor.targetPlayer = assigned;
  }
  for (const boat of activeThreatBoats(world)) searchBoat(world, state, boat, dt, heavy);
  for (const actor of world.freeHostileActors?.actors || []) searchActor(world, state, actor, dt);
  for (const gunner of world.freeHostileGunners?.gunners || []) searchActor(world, state, gunner, dt);

  if (!living.length) {
    for (const group of projectileGroups(world)) {
      if (!Array.isArray(group.items)) continue;
      for (const projectile of group.items) {
        projectile.x += (Number(projectile.vx) || 0) * dt;
        projectile.y += (Number(projectile.vy) || 0) * dt;
        projectile.ttl = (Number(projectile.ttl) || 0) - dt;
      }
    }
  }
}

export function prepareCombatAiV164(world) {
  const state = ensureState(world);
  ensureHeavy(world, state);
  frameSnapshot(world, state);
  return state;
}

export function finishCombatAiV164(world, dt, helpers = {}) {
  void helpers;
  const state = ensureState(world);
  const boat = world.freeHeavyPursuer?.boat;
  const heavy = ensureHeavy(world, state);
  if (boat && heavy) {
    reconcileHeavyDamage(world, state, boat, heavy, state.frame);
    updateHeavyBehaviour(world, state, boat, heavy, state.frame, dt);
  }
  spreadEnemyProjectiles(world);
  updateSearch(world, state, dt);
  trimProjectileRanges(world);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV164(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV164(world);
  return finishCombatAiV164(world, dt, helpers);
}

export {PROJECTILE_RANGES, LEGACY_HEAVY_REPAIR_PHASES, normalizeLegacyHeavyRepair};
