"use strict";

import {applyCombatAiModelV167} from "./free-roam-combat-ai-model-v167.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

// The long-range mega-bomb is capped at 320 metres in free-roam-mega-bomb-v34.
const MEGA_BOMB_RANGE = 320;
const REPAIR_CLEARANCE = MEGA_BOMB_RANGE + 8;
const CUSTOM_PHASES = new Set([
  "breach-escaping-v166",
  "breach-stopping-v166",
  "breach-repairing-v166",
  "breach-returning-v166",
]);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiV168 ||= {
    frame: null,
    players: {},
    mode: null,
    lastModeAt: -999,
    retreatSerial: 0,
  };
  const state = world.freeCombatAiV168;
  state.players ||= {};
  if (!Number.isFinite(state.lastModeAt)) state.lastModeAt = -999;
  if (!Number.isFinite(state.retreatSerial)) state.retreatSerial = 0;
  return state;
}

function pointForPlayer(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return world.boats?.find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function livingPlayers(world) {
  return (world.players || [])
    .map((player, index) => ({player, index, point: pointForPlayer(world, index)}))
    .filter(({player, index, point}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && point);
}

function ammunition(player) {
  const combat = player?.combat || {};
  return Math.max(0, Number(combat.ammo) || 0)
    + Math.max(0, Number(combat.pistolAmmo) || 0)
    + Math.max(0, Number(combat.megaBombStock) || Number(combat.megaBombAmmo) || 0) * 4;
}

function isSwimming(player) {
  return ["swim", "swimming", "water"].includes(String(player?.mode || "").toLowerCase());
}

function observePlayers(world, state, dt) {
  const now = Number(world.time) || 0;
  for (const {player, index, point} of livingPlayers(world)) {
    const key = String(index);
    const memory = state.players[key] ||= {
      x: Number(point.x) || 0,
      y: Number(point.y) || 0,
      heading: Number(point.heading) || 0,
      volatility: 0,
      lastAttackAt: -999,
      lastSeenAt: now,
    };
    const moved = distance(memory, point);
    const headingDelta = Math.abs(wrapDeg((Number(point.heading) || 0) - (Number(memory.heading) || 0)));
    memory.volatility = Math.max(0, (Number(memory.volatility) || 0) - dt * 0.8);
    if (moved > 1.2 && headingDelta > 42) memory.volatility = Math.min(5, memory.volatility + 1.2);
    else if (moved > 2.8) memory.volatility = Math.min(5, memory.volatility + 0.18);
    memory.x = Number(point.x) || 0;
    memory.y = Number(point.y) || 0;
    memory.heading = Number(point.heading) || 0;
    memory.lastSeenAt = now;
    memory.ammo = ammunition(player);
    memory.swimming = isSwimming(player);
  }

  const start = state.frame?.eventStart || 0;
  for (const event of (world.events || []).slice(start)) {
    const source = Number(event?.sourcePlayer);
    if (!Number.isInteger(source) || !state.players[String(source)]) continue;
    if (["gun-shot", "automatic-shot", "automatic-burst", "mega-bomb-launch", "pursuer-hit", "heavy-component-hit", "mega-bomb-explosion"].includes(event.type)) {
      state.players[String(source)].lastAttackAt = now;
    }
  }
}

function targetScore(world, state, boat, item) {
  const memory = state.players[String(item.index)] || {};
  const metres = distance(boat, item.point);
  const swimmer = isSwimming(item.player);
  const ammo = ammunition(item.player);
  const recentAttack = (Number(world.time) || 0) - (Number(memory.lastAttackAt) || -999) < 4;
  return (swimmer ? 900 : 0)
    + (recentAttack ? 260 : 0)
    + Math.min(220, ammo * 2)
    - metres * 0.35;
}

function chooseTarget(world, state, boat) {
  return livingPlayers(world)
    .sort((left, right) => targetScore(world, state, boat, right) - targetScore(world, state, boat, left))[0] || null;
}

function retreatCandidates() {
  const points = [];
  for (const x of [18, 48, 92, 150, 210, 270, 328, 372, 402]) {
    for (const y of [88, 112, 156, 205, 252, 296, 306]) points.push({x, y});
  }
  return points;
}

function safestRetreatPoint(world, boat, serial = 0) {
  const living = livingPlayers(world);
  if (!living.length) return {x: clamp(boat.x, 18, 402), y: clamp(boat.y, 88, 306)};
  return retreatCandidates()
    .map(point => {
      const nearest = Math.min(...living.map(item => distance(point, item.point)));
      const travel = distance(point, boat);
      const edge = Math.min(point.x - 14, 406 - point.x, point.y - 84, 310 - point.y);
      const variation = ((point.x * 17 + point.y * 31 + serial * 13) % 19) * 0.01;
      return {point, nearest, score: nearest * 4 + Math.min(travel, 130) - edge * 0.12 + variation};
    })
    .filter(item => item.travel >= 18)
    .sort((left, right) => right.score - left.score)[0]?.point
    || {x: clamp(boat.x, 18, 402), y: clamp(boat.y, 88, 306)};
}

function nearestPlayerDistance(world, boat) {
  const living = livingPlayers(world);
  return living.length ? Math.min(...living.map(item => distance(boat, item.point))) : Infinity;
}

function incomingBombThreat(world, boat) {
  return (world.freeMegaBombs?.projectiles || []).some(projectile => {
    if (!projectile || Number(projectile.energy) <= 0) return false;
    const ttl = Number(projectile.ttl);
    if (Number.isFinite(ttl) && ttl <= 0) return false;
    const age = Math.max(0, Number(projectile.age) || 0);
    const maxAge = Number(projectile.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0 && age >= maxAge) return false;
    if (["heavy-pursuer", "heavy-turret", "heavy-engine"].includes(projectile.targetId)) return true;
    const target = {x: projectile.targetX ?? projectile.x, y: projectile.targetY ?? projectile.y};
    return distance(target, boat) <= 105 || distance(projectile, boat) <= 145;
  });
}

function announceMode(world, state, mode, target, boat, text) {
  const now = Number(world.time) || 0;
  if (state.mode === mode || now - state.lastModeAt < 1.5) return;
  state.mode = mode;
  state.lastModeAt = now;
  emit(world, "heavy-tactical-mode-v168", text, [0, 1], {
    mode,
    targetPlayer: target?.index,
    x: boat.x,
    y: boat.y,
  });
}

function setEscapeDestination(world, state, heavy, boat) {
  state.retreatSerial += 1;
  const point = safestRetreatPoint(world, boat, state.retreatSerial);
  heavy.destination = point;
  // V167 used this marker to force a bomb-reachable point. Keep it populated
  // with our actual retreat destination so the older overlay does not replace
  // the route again on the next server step.
  heavy.v167ReachableDestination = {x: point.x, y: point.y};
  heavy.v168SafeDestination = {x: point.x, y: point.y};
  return point;
}

function handleRepairSafety(world, state, heavy, boat) {
  if (!CUSTOM_PHASES.has(heavy.phase)) return;
  if (heavy.phase === "breach-escaping-v166") {
    const destination = heavy.destination;
    const destinationUnsafe = !destination || livingPlayers(world).some(item => distance(destination, item.point) < REPAIR_CLEARANCE);
    if (destinationUnsafe) setEscapeDestination(world, state, heavy, boat);
    return;
  }
  if (heavy.phase !== "breach-repairing-v166") return;

  const nearest = nearestPlayerDistance(world, boat);
  const bombIncoming = incomingBombThreat(world, boat);
  if (nearest >= REPAIR_CLEARANCE && !bombIncoming) return;

  // A destroyed engine cannot magically flee. Its repair remains interruptible and exposed.
  if ((Number(boat.engineHealth) || 0) <= 0) {
    if (state.mode !== "engine-trapped-repair") {
      announceMode(world, state, "engine-trapped-repair", null, boat,
        "Двигатель тяжёлого катера уничтожен. Уйти он не может: аварийный ремонт продолжается под угрозой.");
    }
    return;
  }

  heavy.phase = "breach-escaping-v166";
  heavy.repairProgress = Math.max(0, (Number(heavy.repairProgress) || 0) * 0.35);
  setEscapeDestination(world, state, heavy, boat);
  boat.speed = Math.max(Number(boat.speed) || 0, 5.5);
  announceMode(world, state, "repair-aborted", null, boat,
    bombIncoming
      ? "Тяжёлый катер заметил летящую мега-бомбу, сорвал ремонт и снова уходит на полном ходу."
      : "Ты подошёл слишком близко. Тяжёлый катер прервал ремонт и снова уходит на полном ходу.");
}

function movementBand(world, state, target, boat, heavy) {
  const memory = state.players[String(target.index)] || {};
  const ammo = ammunition(target.player);
  const swimmer = isSwimming(target.player);
  const recentAttack = (Number(world.time) || 0) - (Number(memory.lastAttackAt) || -999) < 3.5;
  const damaged = heavy.armourBreached && ((Number(boat.hull) || 0) / Math.max(1, Number(boat.maxHull) || 1) < 0.48
    || (Number(world.time) || 0) - (Number(heavy.lastDamageAt) || -999) < 1.6);

  if (damaged && ammo > 0) return {mode: "disengage", min: 255, max: 292, speed: 15.2, cooldown: 1.8};
  if (swimmer) return {mode: "hunt-swimmer", min: 58, max: 92, speed: 13.6, cooldown: 0.55};
  if (ammo <= 0) return {mode: "press-unarmed", min: 95, max: 128, speed: 12.4, cooldown: 0.8};
  if ((Number(memory.volatility) || 0) >= 1.8 && !recentAttack) {
    return {mode: "probe-unpredictable", min: 145, max: 182, speed: 10.8, cooldown: 1.15};
  }
  return {mode: "standoff", min: 228, max: 276, speed: 12.8, cooldown: 1.45};
}

function moveBoat(boat, destination, desiredSpeed, dt, turnRate = 42) {
  const desired = bearing(boat, destination);
  const error = wrapDeg(desired - (Number(boat.heading) || 0));
  boat.heading = wrapDeg((Number(boat.heading) || 0) + clamp(error, -turnRate * dt, turnRate * dt));
  const alignedSpeed = Math.abs(error) > 70 ? 0 : desiredSpeed;
  boat.speed += clamp(alignedSpeed - (Number(boat.speed) || 0), -10 * dt, 7 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp((Number(boat.x) || 0) + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp((Number(boat.y) || 0) - Math.cos(angle) * boat.speed * dt, 84, 310);
}

function applyCombatMovement(world, state, heavy, boat, target, dt) {
  if (heavy.phase !== "combat" || !target || dt <= 0) return;
  const band = movementBand(world, state, target, boat, heavy);
  const metres = distance(boat, target.point);
  boat.targetPlayer = target.index;

  if ((Number(boat.engineHealth) || 0) > 0) {
    if (metres < band.min) {
      const dx = (Number(boat.x) || 0) - (Number(target.point.x) || 0);
      const dy = (Number(boat.y) || 0) - (Number(target.point.y) || 0);
      const length = Math.hypot(dx, dy) || 1;
      moveBoat(boat, {
        x: clamp((Number(boat.x) || 0) + dx / length * 120, 14, 406),
        y: clamp((Number(boat.y) || 0) + dy / length * 120, 84, 310),
      }, band.speed, dt, 52);
    } else if (metres > band.max) {
      moveBoat(boat, target.point, band.speed * (band.mode === "hunt-swimmer" ? 1.05 : 0.82), dt, 38);
    } else {
      const side = ((target.index + Math.floor((Number(world.time) || 0) / 6)) % 2) ? 1 : -1;
      const angle = bearing(target.point, boat) * Math.PI / 180 + side * Math.PI / 2;
      moveBoat(boat, {
        x: clamp((Number(boat.x) || 0) + Math.sin(angle) * 55, 14, 406),
        y: clamp((Number(boat.y) || 0) - Math.cos(angle) * 55, 84, 310),
      }, 5.2, dt, 34);
    }
  }

  if ((Number(boat.turretHealth) || 0) > 0) {
    boat.turretDisabled = false;
    boat.fireCooldown = Math.min(Math.max(0, Number(boat.fireCooldown) || 0), band.cooldown);
  }

  const text = band.mode === "hunt-swimmer"
    ? "Тяжёлый катер заметил игрока в воде и идёт на решительное сближение, продолжая огонь."
    : band.mode === "press-unarmed"
      ? "Тяжёлый катер понял, что у цели закончились боеприпасы, и осторожно сокращает дистанцию."
      : band.mode === "probe-unpredictable"
        ? "Тяжёлый катер не понимает твой манёвр и осторожно проверяет дистанцию, не подставляя корпус."
        : band.mode === "disengage"
          ? "Повреждённый тяжёлый катер разрывает дистанцию и ведёт дальний бой."
          : "Тяжёлый катер держит дальнюю огневую дистанцию и не идёт под прямой расстрел.";
  announceMode(world, state, band.mode, target, boat, text);
}

function prepareOverlay(world) {
  const state = ensureState(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  state.frame = {
    eventStart: world.events?.length || 0,
    phase: heavy?.phase || null,
    x: Number(boat?.x) || 0,
    y: Number(boat?.y) || 0,
  };

  if (heavy && boat && CUSTOM_PHASES.has(heavy.phase) && heavy.v168SafeDestination) {
    heavy.destination = {...heavy.v168SafeDestination};
    heavy.v167ReachableDestination = {...heavy.v168SafeDestination};
  }
  if (heavy && boat && heavy.phase === "combat" && !boat.destroyed) {
    const target = chooseTarget(world, state, boat);
    if (target) boat.targetPlayer = target.index;
    if ((Number(boat.turretHealth) || 0) > 0) boat.turretDisabled = false;
  }
  return state;
}

function finishOverlay(world, dt) {
  const state = ensureState(world);
  observePlayers(world, state, dt);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  if (!heavy || !boat || !boat.active || boat.destroyed || Number(boat.hull) <= 0) {
    state.frame = null;
    state.mode = null;
    return state;
  }

  handleRepairSafety(world, state, heavy, boat);
  const target = chooseTarget(world, state, boat);
  applyCombatMovement(world, state, heavy, boat, target, dt);
  state.frame = null;
  return state;
}

export function prepareCombatAiV168Overlay(world) {
  return prepareOverlay(world);
}

export function finishCombatAiV168Overlay(world, dt) {
  return finishOverlay(world, Math.max(0, Number(dt) || 0));
}

export function applyCombatAiModelV168(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) {
    prepareOverlay(world);
    applyCombatAiModelV167(world, 0, helpers);
    return ensureState(world);
  }
  applyCombatAiModelV167(world, dt, helpers);
  return finishOverlay(world, dt);
}
