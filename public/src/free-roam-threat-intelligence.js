"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

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
    announcedKnife: {},
    finalWaveEncounterId: null,
    finalWaveAt: 0,
    finalWaveSpawned: false,
  };
  const state = world.freeThreatIntelligence;
  state.lastAlive ||= [];
  state.graceUntil ||= [];
  state.announcedKnife ||= {};
  while (state.lastAlive.length < world.players.length) state.lastAlive.push(null);
  while (state.graceUntil.length < world.players.length) state.graceUntil.push(0);
  if (!Number.isFinite(state.evasionSerial)) state.evasionSerial = 0;
  if (!Number.isFinite(state.finalWaveAt)) state.finalWaveAt = 0;
  if (typeof state.finalWaveSpawned !== "boolean") state.finalWaveSpawned = false;
  return state;
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
    for (const state of [world.freePursuerSquad, world.freeEnemyBoats, world.freeHeavyPursuer, world.freeHostileActors, world.freeHostileGunners]) {
      if (state?.projectiles) state.projectiles = [];
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

function hostileActorTemplate({id, source, weapon, targetPlayer, elite = false, offset = 0}) {
  const maxHealth = elite ? 120 : weapon === "knife" ? 58 : weapon === "automatic" ? 52 : 44;
  return {
    id,
    boatId: source?.id || null,
    targetPlayer,
    x: clamp((Number(source?.x) || 210) + Math.sin(offset * 1.7) * 9, 7, 413),
    y: clamp(Math.max(74, (Number(source?.y) || 90) + Math.cos(offset * 1.3) * 7), 72, 313),
    heading: Number(source?.heading) || 0,
    state: "swim",
    weapon,
    health: maxHealth,
    maxHealth,
    active: true,
    destroyed: false,
    elite,
    fireCooldown: 0.7 + (offset % 5) * 0.34,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0.35 + (offset % 4) * 0.18,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: 0,
    strandedAt: 0,
    stepCooldown: (offset % 3) * 0.17,
    smartAmmo: weapon === "automatic" ? 10 : 0,
    finalWave: true,
  };
}

export function spawnFinalThreatWave(world, state = ensureState(world)) {
  const director = world.freeThreatDirector;
  const heavy = world.freeHeavyPursuer?.boat;
  if (!director?.active || director.level < 5 || !heavy?.active || heavy.destroyed) return 0;
  const present = presentPlayerIndices(world);
  if (!present.length) return 0;
  const hostile = world.freeHostileActors ||= {active: true, level: 5, actors: [], projectiles: [], nextProjectileId: 1, spawnedEncounterId: director.encounterId};
  hostile.actors ||= [];
  hostile.projectiles ||= [];
  hostile.active = true;
  hostile.level = Math.max(5, Number(hostile.level) || 0);
  const activeCount = hostile.actors.filter(actor => actor?.active && !actor.destroyed).length;
  const desiredTotal = present.length > 1 ? 14 : 10;
  const needed = Math.max(0, desiredTotal - activeCount);
  if (!needed) { state.finalWaveSpawned = true; return 0; }
  const sources = [
    heavy,
    ...(world.freeEnemyBoats?.boats || []).filter(boat => boat?.active && !boat.destroyed),
    ...(world.freePursuerSquad?.escorts || []).filter(boat => boat?.active && !boat.destroyed),
    world.freeActivities?.marauder,
  ].filter(source => source?.active !== false && !source?.destroyed);
  const encounterId = Number(director.encounterId) || 0;
  let added = 0;
  for (let index = 0; index < needed; index += 1) {
    const id = `final-wave-${encounterId}-${index + 1}`;
    if (hostile.actors.some(actor => actor.id === id)) continue;
    const weapon = index % 5 < 3 ? "knife" : "automatic";
    const targetPlayer = present[index % present.length];
    const source = sources[index % Math.max(1, sources.length)] || heavy;
    hostile.actors.push(hostileActorTemplate({id, source, weapon, targetPlayer, offset: index + 1}));
    added += 1;
  }
  if (added) {
    emit(
      world,
      "contract-threat-final-wave",
      `Финальная фаза. Тяжёлая установка прикрывает массовую высадку: в бою теперь ${hostile.actors.filter(actor => actor.active && !actor.destroyed).length} физических бойцов.`,
      present,
      {phase: 3, level: 5, count: added, x: heavy.x, y: heavy.y},
    );
  }
  state.finalWaveSpawned = true;
  return added;
}

function updateFinalWave(world, state) {
  const director = world.freeThreatDirector;
  const encounterId = Number(director?.encounterId) || 0;
  if (state.finalWaveEncounterId !== encounterId) {
    state.finalWaveEncounterId = encounterId;
    state.finalWaveAt = 0;
    state.finalWaveSpawned = false;
  }
  const heavy = world.freeHeavyPursuer?.boat;
  if (!director?.active || director.level < 5 || !heavy?.active || heavy.destroyed || state.finalWaveSpawned) return;
  if (!state.finalWaveAt) state.finalWaveAt = (Number(world.time) || 0) + 4.5;
  if ((Number(world.time) || 0) >= state.finalWaveAt) spawnFinalThreatWave(world, state);
}

export function prepareThreatIntelligence(world) {
  const state = ensureState(world);
  const alive = (world.players || []).map((player, index) => Boolean(world.freeActivities?.presence?.[index] && player?.combat?.alive));
  announceAliveTransitions(world, state, alive);
  updateFinalWave(world, state);
  const living = livingThreatTargets(world);
  distributeTargets(world, living);
  prepareFocusEvasion(world, living);
  return {
    hasLivingTargets: living.length > 0,
    eventStart: world.events?.length || 0,
    boats: (world.boats || []).map(boat => ({
      id: boat.id,
      hull: Number(boat.hull) || 0,
      leak: Number(boat.leak) || 0,
      speed: Math.abs(Number(boat.speed) || 0),
      rudder: Math.abs(Number(boat.rudder) || 0),
    })),
  };
}

function deterministicFraction(state, key) {
  state.evasionSerial += 1;
  let value = Math.imul(state.evasionSerial + String(key).length * 97, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
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

function applyWaterPursuit(world, dt) {
  for (const actor of world.freeHostileActors?.actors || []) {
    if (!actor?.active || actor.destroyed || actor.state === "dead") continue;
    const target = world.players?.[actor.targetPlayer];
    if (!target?.combat?.alive || !["swim", "foot"].includes(target.mode)) continue;
    const followingSwimmer = target.mode === "swim";
    const returningToShore = target.mode === "foot" && ["swim", "boarding"].includes(actor.state)
      && (actor.finalWave || actor.switchedToKnife || actor.weapon === "knife" || actor.elite);
    if (!followingSwimmer && !returningToShore) continue;
    const sourceBoat = [
      world.freeHeavyPursuer?.boat,
      ...(world.freeEnemyBoats?.boats || []),
      ...(world.freePursuerSquad?.escorts || []),
      world.freeActivities?.marauder,
    ].find(boat => boat?.id === actor.boatId && boat.active !== false && !boat.destroyed);
    if (actor.state === "aboard") {
      if (!followingSwimmer || !sourceBoat || distance(sourceBoat, target) > (actor.elite ? 82 : 68)) continue;
      actor.x = Number(sourceBoat.x) || actor.x;
      actor.y = Math.max(74, Number(sourceBoat.y) || actor.y);
      emit(world, "hostile-water-entry", actor.elite
        ? "Элитный стрелок прыгнул в воду и преследует тебя вплавь."
        : "Ножевой противник прыгнул в воду и преследует тебя вплавь.", [actor.targetPlayer], {actorId: actor.id, x: actor.x, y: actor.y});
    }
    actor.state = "swim";
    actor.strandedAt = Number(world.time) || 0;
    const destination = followingSwimmer ? target : {x: target.x, y: 72};
    const dx = (Number(destination.x) || 0) - (Number(actor.x) || 0);
    const dy = (Number(destination.y) || 0) - (Number(actor.y) || 0);
    const metres = Math.hypot(dx, dy);
    if (metres < 0.001) continue;
    const speed = actor.elite ? 5.8 : actor.weapon === "knife" ? 5.15 : 4.45;
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

export function finishThreatIntelligence(world, frame, dt) {
  if (!frame) return;
  const state = ensureState(world);
  normaliseKnifeImpactEvents(world, frame);
  restoreFastBoatMisses(world, frame, state);
  applyFiniteAmmunition(world, frame, state);
  applyWaterPursuit(world, dt);
  applyPhysicalEvasion(world, dt);
}
