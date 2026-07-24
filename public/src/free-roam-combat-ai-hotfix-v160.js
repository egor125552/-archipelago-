"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
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
  world.freeCombatAiHotfix ||= {
    openingEncounterId: null,
    pendingRoofHits: [],
    boatHull: {},
    roofByBoat: {},
  };
  const state = world.freeCombatAiHotfix;
  state.pendingRoofHits ||= [];
  state.boatHull ||= {};
  state.roofByBoat ||= {};
  return state;
}

function presentLivingPlayers(world) {
  return (world.players || [])
    .map((player, index) => ({
      player,
      index,
      actor: ["boat", "roof"].includes(player?.mode)
        ? world.boats?.[player.activeBoat] || player
        : player,
    }))
    .filter(({player, index, actor}) => (
      world.freeActivities?.presence?.[index]
      && player?.combat?.alive
      && actor
    ));
}

function activeThreatBoats(world) {
  const boats = [];
  const add = boat => {
    if (boat && boat.active !== false && !boat.destroyed) boats.push(boat);
  };
  add(world.freeActivities?.marauder);
  for (const boat of world.freePursuerSquad?.escorts || []) add(boat);
  for (const boat of world.freeEnemyBoats?.boats || []) add(boat);
  add(world.freeHeavyPursuer?.boat);
  return boats;
}

function openingBoat(world, encounterId, index, targetPlayer) {
  const target = presentLivingPlayers(world).find(candidate => candidate.index === targetPlayer)?.actor || {x: 210, y: 180};
  const side = index % 2 ? 1 : -1;
  const roles = ["rammer", "gunboat", "interceptor"];
  const role = roles[index % roles.length];
  return {
    id: `threat-opening-${encounterId}-${index + 1}`,
    role,
    x: clamp((Number(target.x) || 210) + side * (92 + index * 16), 18, 402),
    y: clamp((Number(target.y) || 180) + 78 + (index % 2) * 20, 92, 302),
    heading: side > 0 ? -35 : 35,
    speed: 0,
    hull: 72,
    maxHull: 72,
    active: true,
    destroyed: false,
    targetPlayer,
    contactCooldown: 1.2 + index * 0.2,
    fireCooldown: 0.7 + index * 0.35,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    crewSeats: 2,
    rewardDropped: false,
    assignmentReleased: false,
    destroyedAt: 0,
    hostile: true,
    observeUntil: 0,
    reinforcementPhase: 1,
  };
}

function crewActor(id, boat, targetPlayer, serial, phase = 1) {
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
    fireCooldown: 0.55 + (serial % 7) * 0.19,
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
    threatPhase: phase,
    finalWave: false,
  };
}

function hostileState(world, encounterId, level) {
  world.freeHostileActors ||= {
    active: true,
    level,
    actors: [],
    projectiles: [],
    nextProjectileId: 1,
    spawnedEncounterId: encounterId,
  };
  const state = world.freeHostileActors;
  state.actors ||= [];
  state.projectiles ||= [];
  state.active = true;
  state.level = Math.max(level, Number(state.level) || 0);
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  return state;
}

function strengthenThreatFiveOpening(world, state) {
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5) return;
  const encounterId = Number(director.encounterId) || 0;
  if (state.openingEncounterId === encounterId) return;
  const living = presentLivingPlayers(world);
  if (!living.length) return;

  const enemyBoats = world.freeEnemyBoats ||= {
    active: true,
    level: 5,
    boats: [],
    projectiles: [],
    nextProjectileId: 1,
  };
  enemyBoats.boats ||= [];
  enemyBoats.projectiles ||= [];
  enemyBoats.active = true;
  enemyBoats.level = 5;

  const activeSpecialBoats = enemyBoats.boats.filter(boat => boat?.active && !boat.destroyed).length;
  for (let index = activeSpecialBoats; index < 3; index += 1) {
    const targetPlayer = living[index % living.length].index;
    enemyBoats.boats.push(openingBoat(world, encounterId, index, targetPlayer));
  }

  const hostile = hostileState(world, encounterId, 5);
  const desiredActors = living.length > 1 ? 8 : 6;
  let activeCount = hostile.actors.filter(actor => actor?.active && !actor.destroyed).length;
  let serial = 1;
  const carriers = activeThreatBoats(world);
  while (activeCount < desiredActors && carriers.length) {
    const id = `threat-opening-actor-${encounterId}-${serial}`;
    if (!hostile.actors.some(actor => actor.id === id)) {
      const boat = carriers[activeCount % carriers.length];
      const targetPlayer = living[activeCount % living.length].index;
      hostile.actors.push(crewActor(id, boat, targetPlayer, serial, 1));
      activeCount += 1;
    }
    serial += 1;
  }
  state.openingEncounterId = encounterId;
}

function ensureEveryBoatHasCrew(world) {
  const director = world.freeThreatDirector;
  const level = Number(director?.level) || 0;
  if (!director?.active || level < 4) return;
  const living = presentLivingPlayers(world);
  if (!living.length) return;
  const encounterId = Number(director.encounterId) || 0;
  const hostile = hostileState(world, encounterId, level);
  const occupied = new Set(hostile.actors
    .filter(actor => actor?.active && !actor.destroyed && actor.boatId != null)
    .map(actor => String(actor.boatId)));
  let serial = hostile.actors.length + 1;
  for (const boat of activeThreatBoats(world)) {
    if (occupied.has(String(boat.id))) continue;
    const id = `hotfix-crew-${encounterId}-${String(boat.id)}`;
    if (hostile.actors.some(actor => actor.id === id)) continue;
    const targetPlayer = living[serial % living.length].index;
    hostile.actors.push(crewActor(id, boat, targetPlayer, serial, level >= 5 ? 1 : 0));
    occupied.add(String(boat.id));
    serial += 1;
  }
}

function deterministicDelay(id, time) {
  let value = Math.floor((Number(time) || 0) * 10) + String(id || "").length * 97;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value >>> 0) / 0xffffffff;
}

function activeCarrier(world, actor) {
  return activeThreatBoats(world).find(boat => String(boat.id) === String(actor.boatId)) || null;
}

function applyStrandedInfantryPressure(world, dt) {
  const group = world.freeHostileActors;
  if (!group?.active) return;
  group.projectiles ||= [];
  if (!Number.isFinite(group.nextProjectileId)) group.nextProjectileId = 1;

  for (const actor of group.actors || []) {
    if (!actor?.active || actor.destroyed || actor.state !== "foot" || !["automatic", "pistol"].includes(actor.weapon)) continue;
    const player = world.players?.[actor.targetPlayer];
    if (!player?.combat?.alive || !["boat", "roof"].includes(player.mode)) continue;
    if (activeCarrier(world, actor)) continue;
    const boat = world.boats?.[player.activeBoat];
    if (!boat || boat.sunk) continue;

    actor.boatPressureCooldown = Math.max(0, (Number(actor.boatPressureCooldown) || 0) - dt);
    const metres = distance(actor, boat);
    const dx = (Number(boat.x) || 0) - (Number(actor.x) || 0);
    if (Math.abs(dx) > 18) {
      actor.x = clamp((Number(actor.x) || 0) + Math.sign(dx) * 7.2 * dt, 5, 415);
      actor.heading = bearing(actor, boat);
    }
    if (actor.boatPressureCooldown > 0 || metres > 260 || group.projectiles.length >= 24) continue;

    const angle = bearing(actor, boat) * Math.PI / 180;
    const speed = actor.weapon === "pistol" ? 64 : 72;
    group.projectiles.push({
      id: `hostile-bullet-${group.nextProjectileId++}`,
      actorId: actor.id,
      targetPlayer: actor.targetPlayer,
      x: actor.x,
      y: actor.y,
      sourceX: actor.x,
      sourceY: actor.y,
      vx: Math.sin(angle) * speed,
      vy: -Math.cos(angle) * speed,
      ttl: 4.2,
      weapon: actor.weapon,
    });
    emit(world, "enemy-gun-shot", "", [0, 1], {
      sourcePlayer: -1,
      gunnerId: actor.id,
      sourcePursuerId: actor.boatId,
      targetPlayer: actor.targetPlayer,
      weapon: actor.weapon,
      x: actor.x,
      y: actor.y,
      heading: actor.heading,
    });
    actor.boatPressureCooldown = 0.8 + deterministicDelay(actor.id, world.time) * 2.4;
  }
}

function roofDamageForEvent(world, event) {
  if (event.type === "heavy-bullet-boat-hit") return {amount: 6, weapon: "heavy-automatic"};
  if (event.gunnerId) {
    const actor = (world.freeHostileActors?.actors || []).find(candidate => candidate.id === event.gunnerId);
    return {amount: actor?.weapon === "pistol" ? 5 : 4, weapon: actor?.weapon || "automatic"};
  }
  const pursuer = [world.freeActivities?.marauder, ...(world.freePursuerSquad?.escorts || [])]
    .find(candidate => String(candidate?.id) === String(event.sourcePursuerId));
  if (pursuer) return {amount: 3, weapon: "automatic"};
  return {amount: 4, weapon: "automatic"};
}

function resolvePendingRoofHits(world, state, helpers) {
  if (typeof helpers?.damagePlayer !== "function") {
    state.pendingRoofHits = [];
    return;
  }
  for (const pending of state.pendingRoofHits) {
    const boat = (world.boats || []).find(candidate => String(candidate?.id) === pending.boatId);
    if (!boat || Number(boat.hull) >= pending.hullBefore) continue;
    const targetIndex = pending.roofPlayers.find(index => (
      world.freeActivities?.presence?.[index]
      && world.players?.[index]?.combat?.alive
    ));
    if (!Number.isInteger(targetIndex)) continue;
    helpers.damagePlayer(world, targetIndex, pending.damage.amount, {
      weapon: pending.damage.weapon,
      eventType: "gun-hit",
      sourcePoint: pending.sourcePoint,
    });
  }
  state.pendingRoofHits = [];
}

function queueNewRoofHits(world, state) {
  const queuedBoats = new Set();
  for (const event of world.events || []) {
    if (!event || event.roofExposureQueued || !["enemy-bullet-boat-hit", "heavy-bullet-boat-hit"].includes(event.type)) continue;
    event.roofExposureQueued = true;
    const boatId = String(event.targetBoat);
    if (queuedBoats.has(boatId)) continue;
    const hullBefore = Number(state.boatHull[boatId]);
    const roofPlayers = Array.isArray(state.roofByBoat[boatId]) ? [...state.roofByBoat[boatId]] : [];
    if (!Number.isFinite(hullBefore) || !roofPlayers.length) continue;
    queuedBoats.add(boatId);
    state.pendingRoofHits.push({
      boatId,
      hullBefore,
      roofPlayers,
      damage: roofDamageForEvent(world, event),
      sourcePoint: {
        x: Number(event.x) || 0,
        y: Number(event.y) || 0,
      },
    });
  }
}

function snapshotRoofState(world, state) {
  const hull = {};
  const roofByBoat = {};
  for (const boat of world.boats || []) hull[String(boat.id)] = Number(boat.hull) || 0;
  for (let index = 0; index < (world.players || []).length; index += 1) {
    const player = world.players[index];
    if (!world.freeActivities?.presence?.[index] || !player?.combat?.alive || player.mode !== "roof") continue;
    const boatId = String(player.activeBoat);
    roofByBoat[boatId] ||= [];
    roofByBoat[boatId].push(index);
  }
  state.boatHull = hull;
  state.roofByBoat = roofByBoat;
}

export function applyCombatAiHotfix(world, dt, helpers = {}) {
  const state = ensureState(world);
  resolvePendingRoofHits(world, state, helpers);
  queueNewRoofHits(world, state);
  strengthenThreatFiveOpening(world, state);
  ensureEveryBoatHasCrew(world);
  applyStrandedInfantryPressure(world, dt);
  snapshotRoofState(world, state);
}
