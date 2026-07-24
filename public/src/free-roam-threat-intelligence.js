"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeThreatIntelligence ||= {
    lastAlive: Array.from({length: world.players?.length || 2}, () => true),
    graceUntil: Array.from({length: world.players?.length || 2}, () => 0),
    evasionSerial: 0,
    announcedKnife: {},
  };
  const state = world.freeThreatIntelligence;
  state.lastAlive ||= [];
  state.graceUntil ||= [];
  state.announcedKnife ||= {};
  while (state.lastAlive.length < world.players.length) state.lastAlive.push(true);
  while (state.graceUntil.length < world.players.length) state.graceUntil.push(0);
  if (!Number.isFinite(state.evasionSerial)) state.evasionSerial = 0;
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
  for (let index = 0; index < alive.length; index += 1) {
    const wasAlive = state.lastAlive[index] !== false;
    const isAlive = alive[index];
    if (wasAlive && !isAlive) {
      const survivor = alive.findIndex(Boolean);
      emit(world, "threat-player-down", survivor >= 0
        ? `Игрок ${index + 1} погиб. Вражеская группа переносит давление на игрока ${survivor + 1}.`
        : "Оба игрока погибли. Враги удерживают район до возрождения.", survivor >= 0 ? [survivor] : [0, 1], {targetPlayer: index});
    } else if (!wasAlive && isAlive) {
      state.graceUntil[index] = (Number(world.time) || 0) + 2.2;
      emit(world, "threat-player-returned", "Ты вернулся в бой. Первые две секунды враги ещё не успели снова тебя обнаружить.", [index], {targetPlayer: index});
    }
    state.lastAlive[index] = isAlive;
  }
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

export function prepareThreatIntelligence(world) {
  const state = ensureState(world);
  const alive = (world.players || []).map((player, index) => Boolean(world.freeActivities?.presence?.[index] && player?.combat?.alive));
  announceAliveTransitions(world, state, alive);
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
  restoreFastBoatMisses(world, frame, state);
  applyFiniteAmmunition(world, frame, state);
  applyPhysicalEvasion(world, dt);
}
