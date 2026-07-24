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

export function ensureHeavyPursuer(world) {
  world.freeHeavyPursuer ||= {
    active: false,
    encounterId: 0,
    boat: null,
    projectiles: [],
    nextProjectileId: 1,
  };
  const state = world.freeHeavyPursuer;
  state.projectiles ||= [];
  if (!Number.isFinite(state.nextProjectileId)) state.nextProjectileId = 1;
  return state;
}

export function activeHeavyPursuer(world) {
  const boat = ensureHeavyPursuer(world).boat;
  return boat?.active && !boat.destroyed ? boat : null;
}

export function startHeavyPursuer(world, encounterId, anchor = {x: 210, y: 180}, targetPlayer = 0) {
  const state = ensureHeavyPursuer(world);
  const coop = (world.freeActivities?.presence || []).filter(Boolean).length > 1;
  const maxHull = coop ? 1000 : 700;
  const maxEngineHealth = 180;
  const maxTurretHealth = 240;
  state.active = true;
  state.encounterId = encounterId;
  state.projectiles = [];
  state.boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: clamp((anchor.x || 210) + 118, 24, 396),
    y: clamp((anchor.y || 180) + 88, 96, 300),
    heading: -38,
    turretHeading: -38,
    speed: 0,
    hull: maxHull,
    maxHull,
    engineHealth: maxEngineHealth,
    maxEngineHealth,
    turretHealth: maxTurretHealth,
    maxTurretHealth,
    engineDisabled: false,
    turretDisabled: false,
    active: true,
    destroyed: false,
    targetPlayer,
    fireCooldown: 2.2,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    contactCooldown: 1.5,
    ramCooldown: 1.5,
    crewSeats: coop ? 2 : 1,
  };
  emit(world, "heavy-pursuer-arrived", `Угроза пять из пяти. В бухту вошёл тяжёлый катер: корпус ${maxHull}, усиленная установка и бронированный двигатель. Это долгий бой.`, [0, 1], {
    x: state.boat.x, y: state.boat.y, hull: maxHull,
  });
  return state.boat;
}

function livingPlayers(world) {
  return world.players.map((player, index) => ({player, index})).filter(({player, index}) => world.freeActivities?.presence?.[index] && player?.combat?.alive);
}

function targetActor(world, boat) {
  let selected = livingPlayers(world).find(item => item.index === boat.targetPlayer);
  if (!selected) selected = livingPlayers(world)[0];
  if (!selected) return null;
  const player = selected.player;
  const actor = ["boat", "roof"].includes(player.mode) ? world.boats[player.activeBoat] || player : player;
  return {...selected, actor};
}

function moveHeavy(world, boat, dt) {
  const target = targetActor(world, boat);
  if (!target) { boat.speed *= Math.max(0, 1 - dt); return; }
  boat.targetPlayer = target.index;
  const desired = bearing(boat, target.actor);
  const delta = clamp(wrapDeg(desired - boat.heading), -28 * dt, 28 * dt);
  boat.heading = wrapDeg(boat.heading + delta);
  const metres = distance(boat, target.actor);
  const engineFactor = boat.engineDisabled ? 0.28 : 0.45 + 0.55 * clamp(boat.engineHealth / boat.maxEngineHealth, 0, 1);
  const desiredSpeed = (metres > 125 ? 10.5 : metres < 42 ? 4.5 : 7.2) * engineFactor;
  boat.speed += clamp(desiredSpeed - boat.speed, -4.5 * dt, 3.2 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp(boat.x + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp(boat.y - Math.cos(angle) * boat.speed * dt, 84, 306);
}

function spawnProjectile(world, state, boat) {
  const target = targetActor(world, boat);
  if (!target || state.projectiles.length >= 48) return false;
  const angle = boat.turretHeading * Math.PI / 180;
  state.projectiles.push({
    id: `heavy-bullet-${state.nextProjectileId++}`,
    x: boat.x,
    y: boat.y,
    sourceX: boat.x,
    sourceY: boat.y,
    vx: Math.sin(angle) * 82,
    vy: -Math.cos(angle) * 82,
    ttl: 5,
    targetPlayer: target.index,
  });
  emit(world, "heavy-gun-shot", "", [0, 1], {sourcePlayer: -1, sourcePursuerId: boat.id, targetPlayer: target.index, x: boat.x, y: boat.y, heading: boat.turretHeading});
  return true;
}

function updateTurret(world, state, boat, dt) {
  boat.fireCooldown = Math.max(0, boat.fireCooldown - dt);
  boat.burstCooldown = Math.max(0, boat.burstCooldown - dt);
  if (boat.turretDisabled || boat.turretHealth <= 0) return;
  const target = targetActor(world, boat);
  if (!target) return;
  const desired = bearing(boat, target.actor);
  boat.turretHeading = wrapDeg(boat.turretHeading + clamp(wrapDeg(desired - boat.turretHeading), -42 * dt, 42 * dt));
  const error = Math.abs(wrapDeg(desired - boat.turretHeading));
  const metres = distance(boat, target.actor);
  if (boat.aimRemaining > 0) {
    boat.aimRemaining = Math.max(0, boat.aimRemaining - dt);
    if (boat.aimRemaining <= 0 && error <= 18) boat.burstRemaining = 28;
    return;
  }
  if (boat.burstRemaining > 0) {
    if (boat.burstCooldown > 0) return;
    if (!spawnProjectile(world, state, boat)) {
      boat.burstCooldown = 0.08;
      return;
    }
    boat.burstRemaining -= 1;
    boat.burstCooldown = 0.095;
    if (boat.burstRemaining <= 0) boat.fireCooldown = 5.4;
    return;
  }
  if (boat.fireCooldown <= 0 && metres <= 245 && error <= 24) {
    boat.aimRemaining = 1.25;
    emit(world, "heavy-gun-windup", "Тяжёлая установка наводится. После сигнала будет длинная очередь: резко меняй курс или заходи в мёртвый сектор.", [target.index], {
      sourcePlayer: -1, sourcePursuerId: boat.id, targetPlayer: target.index, eta: boat.aimRemaining, x: boat.x, y: boat.y,
    });
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
      if (!boat || boat.sunk || !segmentHit(projectile, next, boat, 7)) continue;
      boat.hull = clamp(boat.hull - 5.5, 0.05, 100);
      boat.leak = clamp((Number(boat.leak) || 0) + 0.22, 0, 16);
      const occupants = world.players.map((player, index) => ({player, index})).filter(({player}) => ["boat", "roof"].includes(player.mode) && player.activeBoat === boat.id).map(({index}) => index);
      emit(world, "heavy-bullet-boat-hit", `Тяжёлая очередь попала в лодку. Корпус ${Math.round(boat.hull)}.`, occupants.length ? occupants : [boat.owner], {targetBoat: boat.id, x: next.x, y: next.y});
      hit = true;
      break;
    }
    if (!hit) {
      for (let index = 0; index < world.players.length; index += 1) {
        const player = world.players[index];
        if (!world.freeActivities?.presence?.[index] || !player?.combat?.alive || !["foot", "swim", "roof"].includes(player.mode)) continue;
        if (!segmentHit(projectile, next, player, 2)) continue;
        helpers?.damagePlayer?.(world, index, 6, {weapon: "heavy-automatic", eventType: "gun-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}});
        hit = true;
        break;
      }
    }
    if (hit) continue;
    projectile.x = next.x;
    projectile.y = next.y;
    projectile.ttl -= dt;
    if (projectile.ttl > 0 && projectile.x >= -10 && projectile.x <= 430 && projectile.y >= -10 && projectile.y <= 330) survivors.push(projectile);
  }
  state.projectiles = survivors;
}

function updateRamming(world, boat, dt, helpers) {
  boat.contactCooldown = Math.max(0, boat.contactCooldown - dt);
  boat.ramCooldown = Math.max(0, boat.ramCooldown - dt);
  for (const playerBoat of world.boats || []) {
    if (!playerBoat || playerBoat.sunk || distance(boat, playerBoat) > 16) continue;
    if (boat.ramCooldown <= 0 && boat.speed >= 5) {
      const impact = 14 + boat.speed * 1.4;
      playerBoat.hull = clamp(playerBoat.hull - impact * 0.55, 0.05, 100);
      playerBoat.leak = clamp((Number(playerBoat.leak) || 0) + impact * 0.055, 0, 16);
      playerBoat.speed *= 0.35;
      boat.speed *= 0.6;
      boat.ramCooldown = 3.2;
      emit(world, "heavy-ram-hit", `Тяжёлый катер протаранил лодку. Корпус ${Math.round(playerBoat.hull)}.`, [playerBoat.driver ?? playerBoat.owner], {targetBoat: playerBoat.id, x: playerBoat.x, y: playerBoat.y});
    }
    if (boat.contactCooldown <= 0 && Math.abs(playerBoat.speed) >= 7) {
      const ramDamage = Math.max(9, Math.abs(playerBoat.speed) * 1.15);
      damageHeavyPursuer(world, "hull", ramDamage, playerBoat.driver ?? playerBoat.owner, helpers, {weapon: "ram"});
      playerBoat.hull = clamp(playerBoat.hull - ramDamage * 0.32, 0.05, 100);
      playerBoat.speed *= 0.4;
      boat.contactCooldown = 1.4;
    }
  }
}

export function damageHeavyPursuer(world, component, amount, sourcePlayer = -1, helpers = {}, details = {}) {
  const state = ensureHeavyPursuer(world);
  const boat = activeHeavyPursuer(world);
  if (!boat || amount <= 0) return false;
  if (details.weapon === "pistol" && ["hull", "engine", "turret"].includes(component)) {
    emit(world, "armoured-target", "Пистолет не пробивает броню тяжёлого катера. Используй автомат, таран или стреляй по открытому экипажу.", [sourcePlayer].filter(index => index >= 0), {sourcePlayer, component, x: boat.x, y: boat.y});
    return false;
  }
  if (component === "turret") {
    boat.turretHealth = clamp(boat.turretHealth - amount, 0, boat.maxTurretHealth || 240);
    if (boat.turretHealth <= 0 && !boat.turretDisabled) {
      boat.turretDisabled = true;
      boat.burstRemaining = 0;
      boat.aimRemaining = 0;
      emit(world, "heavy-turret-destroyed", "Тяжёлая оружейная установка выведена из строя.", [0, 1], {sourcePlayer, x: boat.x, y: boat.y});
    }
  } else if (component === "engine") {
    boat.engineHealth = clamp(boat.engineHealth - amount, 0, boat.maxEngineHealth || 180);
    if (boat.engineHealth <= 0 && !boat.engineDisabled) {
      boat.engineDisabled = true;
      emit(world, "heavy-engine-destroyed", "Двигатель тяжёлого катера выведен из строя. Он почти потерял ход.", [0, 1], {sourcePlayer, x: boat.x, y: boat.y});
    }
  } else {
    boat.hull = clamp(boat.hull - amount, 0, boat.maxHull);
  }
  emit(world, "heavy-component-hit", component === "turret"
    ? `Попадание по установке. Прочность ${Math.round(boat.turretHealth)}.`
    : component === "engine" ? `Попадание по двигателю. Прочность ${Math.round(boat.engineHealth)}.`
      : `Попадание по тяжёлому корпусу. Осталось ${Math.round(boat.hull)}.`, [sourcePlayer].filter(index => index >= 0), {
    sourcePlayer, component, weapon: details.weapon, x: boat.x, y: boat.y,
  });
  if (boat.hull > 0) return true;
  boat.active = false;
  boat.destroyed = true;
  boat.speed = 0;
  state.active = false;
  state.projectiles = [];
  emit(world, "heavy-pursuer-destroyed", "Тяжёлый катер уничтожен. Экипаж оказался в воде, а вокруг осталось много трофеев.", [0, 1], {sourcePlayer, x: boat.x, y: boat.y});
  helpers?.onEnemyBoatDestroyed?.(world, boat, sourcePlayer);
  return true;
}

export function heavyCombatTargets(world, attackerIndex) {
  const boat = activeHeavyPursuer(world);
  if (!boat) return [];
  const assigned = boat.targetPlayer === attackerIndex;
  return [
    {id: "heavy-pursuer", kind: "heavyHull", component: "hull", point: boat, label: "корпус тяжёлого катера", assigned},
    {id: "heavy-turret", kind: "heavyTurret", component: "turret", point: boat, label: boat.turretDisabled ? "выведенная из строя тяжёлая установка" : "тяжёлая оружейная установка", assigned},
    {id: "heavy-engine", kind: "heavyEngine", component: "engine", point: boat, label: boat.engineDisabled ? "повреждённый двигатель тяжёлого катера" : "двигатель тяжёлого катера", assigned},
  ];
}

export function updateHeavyPursuer(world, dt, helpers = {}) {
  const state = ensureHeavyPursuer(world);
  const boat = activeHeavyPursuer(world);
  if (!boat) return state;
  moveHeavy(world, boat, dt);
  updateRamming(world, boat, dt, helpers);
  updateTurret(world, state, boat, dt);
  updateProjectiles(world, state, dt, helpers);
  return state;
}
