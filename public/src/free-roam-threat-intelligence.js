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

function presentPlayerIndices(world) {
  return (world.players || [])
    .map((_player, index) => index)
    .filter(index => Boolean(world.freeActivities?.presence?.[index]));
}

function ensureState(world) {
  world.freeThreatIntelligence ||= {
    lastAlive: Array.from({length: world.players?.length || 2}, () => null),
    graceUntil: Array.from({length: world.players?.length || 2}, () => 0),
    evasionSerial: 0,
    cadenceSerial: 0,
    announcedKnife: {},
    encounterId: null,
    phase: 1,
    phase2StartedAt: 0,
    phase2BaselineActors: 0,
    phase2Spawned: false,
    finalWaveSpawned: false,
    nextBoatSerial: 1,
  };
  const state = world.freeThreatIntelligence;
  state.lastAlive ||= [];
  state.graceUntil ||= [];
  state.announcedKnife ||= {};
  while (state.lastAlive.length < (world.players?.length || 0)) state.lastAlive.push(null);
  while (state.graceUntil.length < (world.players?.length || 0)) state.graceUntil.push(0);
  if (!Number.isFinite(state.evasionSerial)) state.evasionSerial = 0;
  if (!Number.isFinite(state.cadenceSerial)) state.cadenceSerial = 0;
  if (!Number.isFinite(state.phase)) state.phase = 1;
  if (!Number.isFinite(state.phase2StartedAt)) state.phase2StartedAt = 0;
  if (!Number.isFinite(state.phase2BaselineActors)) state.phase2BaselineActors = 0;
  if (!Number.isFinite(state.nextBoatSerial)) state.nextBoatSerial = 1;
  if (typeof state.phase2Spawned !== "boolean") state.phase2Spawned = false;
  if (typeof state.finalWaveSpawned !== "boolean") state.finalWaveSpawned = false;
  return state;
}

function syncEncounter(world, state) {
  const director = world.freeThreatDirector;
  const encounterId = director?.active ? Number(director.encounterId) || 0 : null;
  if (state.encounterId === encounterId) return;
  state.encounterId = encounterId;
  state.phase = 1;
  state.phase2StartedAt = 0;
  state.phase2BaselineActors = 0;
  state.phase2Spawned = false;
  state.finalWaveSpawned = false;
  state.nextBoatSerial = 1;
  state.announcedKnife = {};
}

function playerActor(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
  return player;
}

export function livingThreatTargets(world) {
  const state = ensureState(world);
  const now = Number(world.time) || 0;
  return (world.players || [])
    .map((player, index) => ({player, index, actor: playerActor(world, index)}))
    .filter(({player, index, actor}) => (
      world.freeActivities?.presence?.[index]
      && player?.combat?.alive
      && actor
      && now >= (Number(state.graceUntil[index]) || 0)
    ));
}

function activeSources(world) {
  const sources = [];
  const push = item => {
    if (item && item.active !== false && !item.destroyed) sources.push(item);
  };
  push(world.freeActivities?.marauder);
  for (const item of world.freePursuerSquad?.escorts || []) push(item);
  for (const item of world.freeHostileGunners?.gunners || []) push(item);
  for (const item of world.freeEnemyBoats?.boats || []) push(item);
  push(world.freeHeavyPursuer?.boat);
  for (const item of world.freeHostileActors?.actors || []) push(item);
  return sources;
}

function distributeTargets(world, living) {
  const sources = activeSources(world);
  if (!living.length) {
    for (const source of sources) {
      source.targetPlayer = null;
      if (Number.isFinite(source.speed)) source.speed *= 0.94;
      source.burstRemaining = 0;
      source.aimRemaining = 0;
    }
    for (const group of [world.freePursuerSquad, world.freeEnemyBoats, world.freeHeavyPursuer, world.freeHostileActors, world.freeHostileGunners]) {
      if (group?.projectiles) group.projectiles = [];
    }
    return;
  }

  const pressure = new Map(living.map(({index}) => [index, 0]));
  const sorted = [...sources].sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
  for (const source of sorted) {
    const validCurrent = living.find(({index}) => index === source.targetPlayer);
    let selected = validCurrent;
    if (!selected) {
      selected = [...living].sort((left, right) => {
        const pressureDifference = (pressure.get(left.index) || 0) - (pressure.get(right.index) || 0);
        if (pressureDifference) return pressureDifference;
        return distance(source, left.actor) - distance(source, right.actor);
      })[0];
    }
    source.targetPlayer = selected.index;
    pressure.set(selected.index, (pressure.get(selected.index) || 0) + 1);
  }
}

function announceAliveTransitions(world, state, alive) {
  const present = presentPlayerIndices(world);
  const presentSet = new Set(present);
  for (let index = 0; index < alive.length; index += 1) {
    if (!presentSet.has(index)) state.lastAlive[index] = null;
  }

  const died = present.filter(index => state.lastAlive[index] === true && !alive[index]);
  const returned = present.filter(index => state.lastAlive[index] === false && alive[index]);
  const survivors = present.filter(index => alive[index]);

  if (died.length && !survivors.length) {
    emit(
      world,
      "threat-player-down",
      present.length > 1
        ? "Оба игрока погибли. Враги удерживают район до возрождения."
        : "Ты погиб. Враги удерживают район до твоего возрождения.",
      present.length ? present : died,
      {downedPlayers: died},
    );
  } else {
    for (const index of died) {
      const survivor = survivors[0];
      emit(
        world,
        "threat-player-down",
        `Игрок ${index + 1} погиб. Вражеская группа переносит давление на игрока ${survivor + 1}.`,
        survivors,
        {targetPlayer: index},
      );
    }
  }

  for (const index of returned) {
    state.graceUntil[index] = (Number(world.time) || 0) + 2.2;
    emit(world, "threat-player-returned", "Ты вернулся в бой. Первые две секунды враги ещё не успели снова тебя обнаружить.", [index], {targetPlayer: index});
  }
  for (const index of present) state.lastAlive[index] = alive[index];
}

function deterministicFraction(state, key, channel = "evasion") {
  const serialKey = channel === "cadence" ? "cadenceSerial" : "evasionSerial";
  state[serialKey] += 1;
  let value = Math.imul(state[serialKey] + String(key).length * 97, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function focusTarget(world, living) {
  if (living.length < 2) return null;
  const ids = living.map(({player}) => player?.combat?.lockedTargetId).filter(Boolean);
  if (ids.length < 2 || !ids.every(id => id === ids[0])) return null;
  return activeSources(world).find(source => String(source.id) === String(ids[0])) || null;
}

function prepareFocusEvasion(world, living) {
  const target = focusTarget(world, living);
  if (!target) return;
  target.evasiveUntil = Math.max(Number(target.evasiveUntil) || 0, (Number(world.time) || 0) + 2.8);
}

function hostileActorTemplate({id, source, weapon, targetPlayer, elite = false, offset = 0, phase = 1}) {
  const maxHealth = elite ? 120 : weapon === "knife" ? 58 : weapon === "automatic" ? 52 : 44;
  return {
    id,
    boatId: source?.id || null,
    targetPlayer,
    x: clamp((Number(source?.x) || 210) + Math.sin(offset * 1.7) * 6, 7, 413),
    y: clamp(Math.max(74, (Number(source?.y) || 90) + Math.cos(offset * 1.3) * 5), 72, 313),
    heading: Number(source?.heading) || 0,
    state: source ? "aboard" : "swim",
    weapon,
    health: maxHealth,
    maxHealth,
    active: true,
    destroyed: false,
    elite,
    fireCooldown: 0.45 + ((offset * 37) % 13) * 0.17,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0.25 + ((offset * 19) % 7) * 0.13,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: offset % 2 ? 2.2 : -2.2,
    strandedAt: 0,
    stepCooldown: ((offset * 11) % 5) * 0.14,
    smartAmmo: weapon === "automatic" ? (phase >= 3 ? 12 : 8) : weapon === "pistol" ? 5 : 0,
    threatPhase: phase,
    finalWave: phase >= 3,
  };
}

function reinforcementBoatTemplate(world, state, role, targetPlayer, phase, offset) {
  const target = playerActor(world, targetPlayer) || {x: 210, y: 180};
  const side = offset % 2 ? 1 : -1;
  const serial = state.nextBoatSerial++;
  const hull = phase >= 3 ? 82 : 72;
  return {
    id: `threat-reinforcement-${state.encounterId || 0}-${phase}-${serial}`,
    role,
    x: clamp((Number(target.x) || 210) + side * (82 + offset * 11), 18, 402),
    y: clamp((Number(target.y) || 180) + 72 + (offset % 3) * 18, 92, 302),
    heading: side > 0 ? -35 : 35,
    speed: 0,
    hull,
    maxHull: hull,
    active: true,
    destroyed: false,
    targetPlayer,
    contactCooldown: 1.1 + offset * 0.2,
    fireCooldown: 0.55 + offset * 0.31,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    crewSeats: phase >= 3 ? 3 : 2,
    rewardDropped: false,
    assignmentReleased: false,
    destroyedAt: 0,
    hostile: true,
    observeUntil: 0,
    reinforcementPhase: phase,
  };
}

function spawnReinforcementBoats(world, state, phase, count) {
  world.freeEnemyBoats ||= {active: true, level: 5, boats: [], projectiles: [], nextProjectileId: 1};
  const group = world.freeEnemyBoats;
  group.boats ||= [];
  group.projectiles ||= [];
  group.active = true;
  group.level = Math.max(5, Number(group.level) || 0);
  const present = presentPlayerIndices(world);
  if (!present.length) return [];
  const roles = phase >= 3
    ? ["rammer", "gunboat", "interceptor", "rammer"]
    : ["interceptor", "gunboat", "rammer"];
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const targetPlayer = present[index % present.length];
    const boat = reinforcementBoatTemplate(world, state, roles[index % roles.length], targetPlayer, phase, index + 1);
    group.boats.push(boat);
    created.push(boat);
  }
  return created;
}

function actorSources(world) {
  return [
    world.freeHeavyPursuer?.boat,
    ...(world.freeEnemyBoats?.boats || []),
    ...(world.freePursuerSquad?.escorts || []),
    world.freeActivities?.marauder,
  ].filter(source => Boolean(source) && source.active !== false && !source.destroyed);
}

function fillActorsToTotal(world, state, phase, desiredTotal) {
  const present = presentPlayerIndices(world);
  if (!present.length) return 0;
  const hostile = world.freeHostileActors ||= {active: true, level: 5, actors: [], projectiles: [], nextProjectileId: 1, spawnedEncounterId: state.encounterId};
  hostile.actors ||= [];
  hostile.projectiles ||= [];
  hostile.active = true;
  hostile.level = Math.max(5, Number(hostile.level) || 0);
  const activeCount = hostile.actors.filter(actor => actor?.active && !actor.destroyed).length;
  const needed = Math.max(0, desiredTotal - activeCount);
  const sources = actorSources(world);
  let added = 0;
  for (let index = 0; index < needed; index += 1) {
    const id = `threat-phase-${state.encounterId || 0}-${phase}-${index + 1}`;
    if (hostile.actors.some(actor => actor.id === id)) continue;
    const weapon = phase >= 3
      ? (index % 7 < 4 ? "knife" : "automatic")
      : (index % 5 < 3 ? "knife" : "automatic");
    const targetPlayer = present[index % present.length];
    const source = sources[index % Math.max(1, sources.length)] || null;
    hostile.actors.push(hostileActorTemplate({id, source, weapon, targetPlayer, offset: index + 1, phase}));
    added += 1;
  }
  return added;
}

function startSecondPhase(world, state) {
  if (state.phase2Spawned) return 0;
  const present = presentPlayerIndices(world);
  if (!present.length) return 0;
  const boats = spawnReinforcementBoats(world, state, 2, present.length > 1 ? 3 : 2);
  const actorTotal = present.length > 1 ? 14 : 10;
  const actors = fillActorsToTotal(world, state, 2, actorTotal);
  state.phase = 2;
  state.phase2Spawned = true;
  state.phase2StartedAt = Number(world.time) || 0;
  state.phase2BaselineActors = (world.freeHostileActors?.actors || []).filter(actor => actor?.active && !actor.destroyed).length;
  const heavy = world.freeHeavyPursuer?.boat;
  emit(
    world,
    "contract-threat-phase-two",
    `Вторая фаза. Подошли ещё ${boats.length} катера, а все экипажи получили приказ высаживаться. В бою ${state.phase2BaselineActors} физических бойцов.`,
    present,
    {phase: 2, boats: boats.length, actors, x: heavy?.x, y: heavy?.y},
  );
  return boats.length + actors;
}

function finalPhaseReady(world, state) {
  if (!state.phase2Spawned || state.finalWaveSpawned) return false;
  const heavy = world.freeHeavyPursuer?.boat;
  if (!heavy) return false;
  if (heavy.destroyed || heavy.active === false) return true;
  const maxHull = Math.max(1, Number(heavy.maxHull) || Number(heavy.hull) || 1);
  const damagedHeavy = Number(heavy.hull) <= maxHull * 0.68 || heavy.turretDisabled || heavy.engineDisabled;
  const activeActors = (world.freeHostileActors?.actors || []).filter(actor => actor?.active && !actor.destroyed).length;
  const attritionThreshold = Math.max(4, Math.floor((Number(state.phase2BaselineActors) || activeActors) * 0.55));
  const attrition = activeActors <= attritionThreshold;
  const elapsed = (Number(world.time) || 0) - (Number(state.phase2StartedAt) || 0);
  return damagedHeavy || (attrition && elapsed >= 8) || elapsed >= 42;
}

export function spawnFinalThreatWave(world, state = ensureState(world)) {
  const director = world.freeThreatDirector;
  const heavy = world.freeHeavyPursuer?.boat;
  if (!director?.active || director.level < 5 || !heavy || state.finalWaveSpawned) return 0;
  const present = presentPlayerIndices(world);
  if (!present.length) return 0;
  const boats = spawnReinforcementBoats(world, state, 3, present.length > 1 ? 3 : 2);
  const desiredTotal = present.length > 1 ? 22 : 16;
  const actors = fillActorsToTotal(world, state, 3, desiredTotal);
  state.phase = 3;
  state.finalWaveSpawned = true;
  const totalActors = (world.freeHostileActors?.actors || []).filter(actor => actor?.active && !actor.destroyed).length;
  emit(
    world,
    "contract-threat-final-wave",
    `Финальная фаза. Резервные катера вошли с двух сторон. Все экипажи высаживаются: в бою ${totalActors} физических бойцов, часть с ножами, часть ведёт нерегулярный огонь.`,
    present,
    {phase: 3, level: 5, boats: boats.length, actors, count: totalActors, x: heavy.x, y: heavy.y, heavyDestroyed: Boolean(heavy.destroyed)},
  );
  return boats.length + actors;
}

function updateThreatPhases(world, state) {
  const director = world.freeThreatDirector;
  if (!director?.active || director.level < 5) return;
  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && !state.phase2Spawned) startSecondPhase(world, state);
  if (finalPhaseReady(world, state)) spawnFinalThreatWave(world, state);
}

function forceCrewDeployment(world, dt) {
  const sources = actorSources(world);
  const sourceById = new Map(sources.map(source => [source.id, source]));
  for (const actor of world.freeHostileActors?.actors || []) {
    if (!actor?.active || actor.destroyed || actor.state === "dead") continue;
    const target = world.players?.[actor.targetPlayer];
    if (!target?.combat?.alive) continue;
    const sourceBoat = sourceById.get(actor.boatId) || null;

    if (target.mode === "swim") {
      if (actor.state === "aboard") {
        actor.x = Number(sourceBoat?.x) || actor.x;
        actor.y = Math.max(74, Number(sourceBoat?.y) || actor.y);
        actor.state = "swim";
        emit(world, "hostile-water-entry", actor.elite
          ? "Элитный стрелок прыгнул в воду и преследует тебя вплавь."
          : actor.weapon === "knife"
            ? "Ножевой противник прыгнул в воду и преследует тебя вплавь."
            : "Стрелок покинул катер и преследует тебя в воде.", [actor.targetPlayer], {actorId: actor.id, x: actor.x, y: actor.y});
      }
      continue;
    }

    if (target.mode !== "foot" || actor.state !== "aboard" || !sourceBoat) continue;
    const shorePoint = {x: target.x, y: 78};
    const desiredHeading = bearing(sourceBoat, shorePoint);
    sourceBoat.heading = wrapDeg((Number(sourceBoat.heading) || 0) + clamp(wrapDeg(desiredHeading - (Number(sourceBoat.heading) || 0)), -80 * dt, 80 * dt));
    sourceBoat.speed = Math.max(Number(sourceBoat.speed) || 0, sourceBoat.role === "rammer" ? 12 : 9);
    if (distance(sourceBoat, shorePoint) > 58 && sourceBoat.y > 96) continue;
    actor.state = "disembarking";
    actor.x = sourceBoat.x;
    actor.y = Math.max(72, sourceBoat.y);
    emit(world, "pursuer-gunner-landed", actor.weapon === "knife"
      ? "Ножевой боец высадился с катера и идёт к тебе."
      : "Стрелок высадился с катера и занял позицию на берегу.", [actor.targetPlayer], {actorId: actor.id, sourcePursuerId: actor.boatId, x: actor.x, y: actor.y});
  }
}

function applyWaterPursuit(world, dt) {
  for (const actor of world.freeHostileActors?.actors || []) {
    if (!actor?.active || actor.destroyed || actor.state === "dead") continue;
    const target = world.players?.[actor.targetPlayer];
    if (!target?.combat?.alive || !["swim", "foot"].includes(target.mode)) continue;
    const followingSwimmer = target.mode === "swim";
    const returningToShore = target.mode === "foot" && ["swim", "boarding"].includes(actor.state);
    if (!followingSwimmer && !returningToShore) continue;
    actor.state = "swim";
    actor.strandedAt = Number(world.time) || 0;
    const destination = followingSwimmer ? target : {x: target.x, y: 72};
    const dx = (Number(destination.x) || 0) - (Number(actor.x) || 0);
    const dy = (Number(destination.y) || 0) - (Number(actor.y) || 0);
    const metres = Math.hypot(dx, dy);
    if (metres < 0.001) continue;
    const speed = actor.elite ? 9.8 : actor.weapon === "knife" ? 9 : 7.4;
    actor.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
    actor.x = clamp(actor.x + dx / metres * speed * dt, 5, 415);
    actor.y = clamp(actor.y + dy / metres * speed * dt, 72, 313);
    if (!followingSwimmer && metres <= 4.5) {
      actor.state = "foot";
      actor.y = 69;
    }
    actor.stepCooldown = Math.max(0, (Number(actor.stepCooldown) || 0) - dt);
    if (actor.stepCooldown <= 0 && metres > 3) {
      actor.stepCooldown = actor.elite ? 0.46 : 0.68;
      emit(world, "hostile-swim-step", "", [0, 1], {actorId: actor.id, elite: actor.elite, targetPlayer: actor.targetPlayer, x: actor.x, y: actor.y, heading: actor.heading});
    }
  }
}

function applyHeavyChase(world, dt) {
  const heavy = world.freeHeavyPursuer?.boat;
  if (!heavy?.active || heavy.destroyed || heavy.engineDisabled) return;
  const living = livingThreatTargets(world);
  if (!living.length) return;
  const selected = living.find(item => item.index === heavy.targetPlayer)
    || [...living].sort((left, right) => distance(heavy, left.actor) - distance(heavy, right.actor))[0];
  heavy.targetPlayer = selected.index;
  const target = selected.actor;
  const metres = distance(heavy, target);
  const desiredRange = ["foot", "swim"].includes(selected.player.mode) ? 34 : 52;
  const desiredHeading = bearing(heavy, target);
  heavy.heading = wrapDeg((Number(heavy.heading) || 0) + clamp(wrapDeg(desiredHeading - (Number(heavy.heading) || 0)), -46 * dt, 46 * dt));
  const desiredSpeed = metres > desiredRange + 20 ? 14 : metres > desiredRange ? 9 : metres < desiredRange - 12 ? -4 : 3;
  heavy.speed = (Number(heavy.speed) || 0) + clamp(desiredSpeed - (Number(heavy.speed) || 0), -7 * dt, 6 * dt);
  const angle = heavy.heading * Math.PI / 180;
  heavy.x = clamp(heavy.x + Math.sin(angle) * heavy.speed * dt, 9, 411);
  heavy.y = clamp(heavy.y - Math.cos(angle) * heavy.speed * dt, 78, 311);
}

function normaliseKnifeImpactEvents(world, frame) {
  for (const event of (world.events || []).slice(frame.eventStart)) {
    if (event.type !== "enemy-knife-hit") continue;
    event.originalType = "enemy-knife-hit";
    event.type = "combat-hit";
    event.centeredImpact = true;
  }
}

function restoreFastBoatMisses(world, frame, state) {
  const events = (world.events || []).slice(frame.eventStart);
  for (const before of frame.boats || []) {
    const boat = world.boats?.find(candidate => candidate.id === before.id);
    if (!boat || boat.sunk || before.speed < 5) continue;
    const bulletHits = events.filter(event => (
      ["enemy-bullet-boat-hit", "heavy-bullet-boat-hit"].includes(event.type)
      && event.targetBoat === boat.id
    ));
    if (!bulletHits.length || boat.hull >= before.hull) continue;
    const speedFactor = clamp(before.speed / 19, 0, 1);
    const turnFactor = clamp(before.rudder, 0, 1);
    const missChance = clamp(0.08 + speedFactor * 0.45 + turnFactor * 0.2, 0.08, 0.65);
    let misses = 0;
    for (const event of bulletHits) {
      if (deterministicFraction(state, `${boat.id}:${event.type}`) < missChance) misses += 1;
    }
    if (!misses) continue;
    const portion = misses / bulletHits.length;
    const hullLoss = Math.max(0, before.hull - boat.hull);
    const leakGain = Math.max(0, (Number(boat.leak) || 0) - before.leak);
    boat.hull = clamp(boat.hull + hullLoss * portion, 0.05, 100);
    boat.leak = clamp((Number(boat.leak) || 0) - leakGain * portion, 0, 16);
    const occupants = (world.players || [])
      .map((player, index) => ({player, index}))
      .filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id)
      .map(({index}) => index);
    emit(world, "enemy-bullet-near", "Часть пуль прошла мимо из-за скорости и манёвра лодки.", occupants.length ? occupants : [boat.owner].filter(Number.isInteger), {targetBoat: boat.id, misses});
  }
}

function applyPhysicalEvasion(world, dt) {
  const now = Number(world.time) || 0;
  for (const source of activeSources(world)) {
    if ((Number(source.evasiveUntil) || 0) <= now || !Number.isFinite(source.x) || !Number.isFinite(source.y)) continue;
    const heading = (Number(source.heading) || 0) * Math.PI / 180;
    const side = (Math.floor(now * 1.8 + String(source.id || "").length) % 2 ? 1 : -1);
    source.x = clamp(source.x + Math.cos(heading) * side * 5.5 * dt, 7, 413);
    source.y = clamp(source.y + Math.sin(heading) * side * 5.5 * dt, 5, 313);
  }
}

function applyIrregularFireCadence(world, frame, state) {
  const events = (world.events || []).slice(frame.eventStart);
  for (const event of events) {
    if (event.type !== "enemy-gun-shot") continue;
    const actor = event.gunnerId
      ? (world.freeHostileActors?.actors || []).find(candidate => candidate.id === event.gunnerId)
      : null;
    const boat = !actor && event.sourcePursuerId
      ? (world.freeEnemyBoats?.boats || []).find(candidate => candidate.id === event.sourcePursuerId)
      : null;
    const shooter = actor || boat;
    if (!shooter || shooter.destroyed) continue;
    const first = deterministicFraction(state, shooter.id, "cadence");
    const second = deterministicFraction(state, `${shooter.id}:delay`, "cadence");
    if (first < 0.46) {
      shooter.burstRemaining = 0;
      shooter.fireCooldown = Math.max(Number(shooter.fireCooldown) || 0, 0.7 + second * 2.9);
    } else if (first < 0.78) {
      shooter.burstRemaining = Math.min(Number(shooter.burstRemaining) || 0, 1);
      shooter.burstCooldown = 0.16 + second * 0.28;
    } else {
      shooter.burstRemaining = Math.min(Number(shooter.burstRemaining) || 0, 3);
      shooter.burstCooldown = 0.1 + second * 0.16;
    }
  }
}

function applyFiniteAmmunition(world, frame, state) {
  const events = (world.events || []).slice(frame.eventStart);
  for (const event of events) {
    if (event.type !== "enemy-gun-shot" || !event.gunnerId) continue;
    const actor = (world.freeHostileActors?.actors || []).find(candidate => candidate.id === event.gunnerId);
    if (!actor || actor.weapon === "knife" || actor.destroyed) continue;
    if (!Number.isFinite(actor.smartAmmo)) actor.smartAmmo = actor.elite ? 24 : actor.weapon === "automatic" ? 12 : 6;
    actor.smartAmmo = Math.max(0, actor.smartAmmo - 1);
    if (actor.smartAmmo > 0) continue;
    actor.weapon = "knife";
    actor.burstRemaining = 0;
    actor.aimRemaining = 0;
    actor.switchedToKnife = true;
    if (!state.announcedKnife[actor.id]) {
      state.announcedKnife[actor.id] = true;
      emit(world, "hostile-out-of-ammo", actor.elite
        ? "У элитного стрелка закончились патроны. Он достал нож и идёт в ближний бой."
        : "У вражеского стрелка закончились патроны. Он перешёл на нож.", [actor.targetPlayer].filter(Number.isInteger), {actorId: actor.id, x: actor.x, y: actor.y});
    }
  }
}

export function prepareThreatIntelligence(world) {
  const state = ensureState(world);
  syncEncounter(world, state);
  const alive = (world.players || []).map((player, index) => Boolean(world.freeActivities?.presence?.[index] && player?.combat?.alive));
  announceAliveTransitions(world, state, alive);
  updateThreatPhases(world, state);
  const living = livingThreatTargets(world);
  distributeTargets(world, living);
  prepareFocusEvasion(world, living);
  return {
    hasLivingTargets: living.length > 0,
    eventStart: world.events?.length || 0,
    phase: state.phase,
    boats: (world.boats || []).map(boat => ({
      id: boat.id,
      hull: Number(boat.hull) || 0,
      leak: Number(boat.leak) || 0,
      speed: Math.abs(Number(boat.speed) || 0),
      rudder: Math.abs(Number(boat.rudder) || 0),
    })),
  };
}

export function finishThreatIntelligence(world, frame, dt) {
  if (!frame) return;
  const state = ensureState(world);
  normaliseKnifeImpactEvents(world, frame);
  restoreFastBoatMisses(world, frame, state);
  applyIrregularFireCadence(world, frame, state);
  applyFiniteAmmunition(world, frame, state);
  forceCrewDeployment(world, dt);
  applyWaterPursuit(world, dt);
  applyHeavyChase(world, dt);
  applyPhysicalEvasion(world, dt);
}
