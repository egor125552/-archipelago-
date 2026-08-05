"use strict";

import {addEliteCommander, hostileActorById} from "./free-roam-hostile-actors.js?v=3";

export const ELITE_BOSS_VERSION = "1.4.0";
export const ELITE_ARMOR_LAYER_HP = 1000;
export const ELITE_HULL_HP = 5000;
export const ELITE_TURRET_HP = 520;
export const ELITE_BOMB_BAY_HP = 700;
export const ELITE_BULLET_SPEED = 138;
export const ELITE_MAX_SPEED = 23;
export const ELITE_BOMB_RELOAD_SECONDS = 10;

const ARMOR_IDS = Object.freeze(["outer", "middle", "inner"]);
const WORLD_BOUNDS = Object.freeze({minX: 15, maxX: 405, minY: 84, maxY: 305});
const BOMB_BAY_OPEN_SECONDS = 0.58;
const BOMB_BAY_CLOSE_SECONDS = 0.42;
const BOMB_SALVO_SIZE = 3;
const BOMB_SALVO_INTERVAL = 0.42;
const TURRET_BURST_SIZE = 20;
const TURRET_SHOT_INTERVAL = 0.068;
const DECISION_INTERVAL_SECONDS = 0.18;
const BULLET_LIMIT = 96;
const BOMB_REQUEST_LIMIT = 12;
const BULLET_MASS = 0.018;
const BULLET_INHERITANCE = 0.42;
const BULLET_ENERGY_LOSS_PER_SECOND = 0.07;
const BULLET_FLYBY_RADIUS = 12;
const RAM_RANGE = 8.5;
const RAM_COOLDOWN_SECONDS = 2.8;
const RAM_DAMAGE_TO_TARGET = 20;
const RAM_SELF_DAMAGE = 90;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2((Number(to?.x) || 0) - (Number(from?.x) || 0), -((Number(to?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
const headingVector = heading => ({x: Math.sin((Number(heading) || 0) * Math.PI / 180), y: -Math.cos((Number(heading) || 0) * Math.PI / 180)});
const rightVector = heading => ({x: Math.cos((Number(heading) || 0) * Math.PI / 180), y: Math.sin((Number(heading) || 0) * Math.PI / 180)});
const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, eliteBossVersion: ELITE_BOSS_VERSION, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function armorLayers() {
  return ARMOR_IDS.map((id, index) => ({id, hp: ELITE_ARMOR_LAYER_HP, maxHp: ELITE_ARMOR_LAYER_HP, state: index === 0 ? "active" : "protected", criticalAnnounced: false, destroyedAnnounced: false}));
}

function createTurret(id, side) {
  return {id: `elite-turret-${id}`, side, hp: ELITE_TURRET_HP, maxHp: ELITE_TURRET_HP, state: "ready", destroyed: false, targetPlayer: null, heading: 0, windup: 0, burstRemaining: 0, shotCooldown: 0, fireCooldown: side === "port" ? 0.9 : 1.18, tacticalRole: side === "port" ? "primary-suppression" : "secondary-denial", lastTargetChangeAt: -999};
}

function createBombBay() {
  return {id: "elite-bomb-bay-main", hp: ELITE_BOMB_BAY_HP, maxHp: ELITE_BOMB_BAY_HP, state: "closed", destroyed: false, ammo: 999, exposed: false, internalDetonationResolved: false};
}

function createPlayerMemory() {
  return {lastX: null, lastY: null, lastSeenAt: -999, observedSpeed: 0, observedHeading: 0, lastHeading: null, routeChanges: 0, recentFire: 0, pursuitPressure: 0, damagePressure: 0, threatScore: 0, lastTargetedAt: -999, shotsObserved: 0};
}

function createTacticalState(playerCount = 2) {
  return {decisionCooldown: 0, movementState: "observe", movementStateUntil: 0, movementSide: 1, primaryTarget: null, secondaryTarget: null, playerMemory: Array.from({length: playerCount}, () => createPlayerMemory()), teamMemory: {encirclement: 0, splitPressure: 0, lastBreakoutAt: -999}, tacticHistory: [], tacticScores: {}, lastHull: null, lastTurretHp: {}, lastBombBayHp: null, salvoSerial: 0, salvoPlan: [], salvoPlanIndex: 0, disarmedSince: null, boundaryContacts: 0, lastBoundaryHeading: null};
}

function normalizeArmorLayers(value) {
  const existing = values(value);
  return armorLayers().map(fallback => {
    const current = existing.find(layer => layer?.id === fallback.id);
    if (!current) return fallback;
    return {...fallback, ...current, id: fallback.id, hp: clamp(current.hp ?? fallback.hp, 0, current.maxHp ?? fallback.maxHp), maxHp: Math.max(1, finite(current.maxHp, fallback.maxHp))};
  });
}

function normalizeTurrets(value) {
  const existing = values(value);
  return [createTurret("port", "port"), createTurret("starboard", "starboard")].map(fallback => {
    const current = existing.find(turret => turret?.id === fallback.id || turret?.side === fallback.side);
    if (!current) return fallback;
    return {...fallback, ...current, id: fallback.id, side: fallback.side, hp: clamp(current.hp ?? fallback.hp, 0, current.maxHp ?? fallback.maxHp), maxHp: Math.max(1, finite(current.maxHp, fallback.maxHp)), destroyed: current.destroyed === true || Number(current.hp) <= 0};
  });
}

function normalizeBombBay(value) {
  const fallback = createBombBay();
  if (!value || typeof value !== "object") return fallback;
  const hp = clamp(value.hp ?? fallback.hp, 0, value.maxHp ?? fallback.maxHp);
  return {...fallback, ...value, id: fallback.id, hp, maxHp: Math.max(1, finite(value.maxHp, fallback.maxHp)), destroyed: value.destroyed === true || hp <= 0, state: value.destroyed === true || hp <= 0 ? "destroyed" : String(value.state || fallback.state)};
}

function normalizeTacticalState(value, playerCount) {
  const fallback = createTacticalState(playerCount);
  const tactical = value && typeof value === "object" ? {...fallback, ...value} : fallback;
  tactical.playerMemory = values(tactical.playerMemory);
  while (tactical.playerMemory.length < playerCount) tactical.playerMemory.push(createPlayerMemory());
  tactical.playerMemory = tactical.playerMemory.slice(0, playerCount).map(memory => ({...createPlayerMemory(), ...(memory || {})}));
  tactical.teamMemory = {...fallback.teamMemory, ...(tactical.teamMemory || {})};
  tactical.tacticHistory = values(tactical.tacticHistory);
  tactical.tacticScores = tactical.tacticScores && typeof tactical.tacticScores === "object" ? tactical.tacticScores : {};
  tactical.salvoPlan = values(tactical.salvoPlan);
  tactical.lastTurretHp = tactical.lastTurretHp && typeof tactical.lastTurretHp === "object" ? tactical.lastTurretHp : {};
  return tactical;
}

function defaultState(playerCount = 2) {
  return {version: ELITE_BOSS_VERSION, active: false, encounterId: 0, threatEncounterId: 0, phase: "inactive", stage: "armor-outer", startedAt: 0, completedAt: 0, completionAnnounced: false, rewardReady: false, boat: null, projectiles: [], projectileEndEvents: [], nextProjectileId: 1, bombRequests: [], nextBombRequestId: 1, bombCooldown: 0, salvoRemaining: 0, salvoCooldown: 0, bombBayState: "closed", bombBayTimer: 0, bombBay: createBombBay(), commanderId: null, commanderSpawned: false, deployRemaining: 0, cleanupReason: null, tactical: createTacticalState(playerCount)};
}

function setBombBayState(state, next, timer = 0) {
  const bay = state.bombBay ||= createBombBay();
  const effective = bay.destroyed ? "destroyed" : next;
  state.bombBayState = effective;
  state.bombBayTimer = Math.max(0, finite(timer));
  bay.state = effective;
  bay.exposed = ["opening", "open"].includes(effective);
  if (state.boat) {
    state.boat.bombBayState = effective;
    state.boat.bombCooldown = state.bombCooldown;
    state.boat.salvoRemaining = state.salvoRemaining;
    state.boat.bombBay = bay;
  }
}

export function ensureEliteBoatBoss(world) {
  world.freeEliteBoatBoss ||= defaultState(world.players?.length || 2);
  const state = world.freeEliteBoatBoss;
  state.version = ELITE_BOSS_VERSION;
  state.projectiles = values(state.projectiles);
  state.projectileEndEvents = values(state.projectileEndEvents);
  state.bombRequests = values(state.bombRequests);
  state.bombBay = normalizeBombBay(state.bombBay);
  state.tactical = normalizeTacticalState(state.tactical, world.players?.length || 2);
  if (!Number.isFinite(Number(state.nextProjectileId))) state.nextProjectileId = 1;
  if (!Number.isFinite(Number(state.nextBombRequestId))) state.nextBombRequestId = 1;
  if (!Number.isFinite(Number(state.bombCooldown))) state.bombCooldown = 0;
  if (!Number.isFinite(Number(state.salvoRemaining))) state.salvoRemaining = 0;
  if (!Number.isFinite(Number(state.salvoCooldown))) state.salvoCooldown = 0;
  if (!Number.isFinite(Number(state.bombBayTimer))) state.bombBayTimer = 0;
  if (!Number.isFinite(Number(state.deployRemaining))) state.deployRemaining = 0;
  if (!["closed", "opening", "open", "closing", "destroyed"].includes(state.bombBayState)) state.bombBayState = state.bombBay.destroyed ? "destroyed" : "closed";
  if (state.bombBay.destroyed) state.bombBayState = "destroyed";
  if (state.boat) {
    state.boat.armorLayers = normalizeArmorLayers(state.boat.armorLayers);
    state.boat.turrets = normalizeTurrets(state.boat.turrets);
    if (!Number.isInteger(Number(state.boat.activeArmorIndex))) state.boat.activeArmorIndex = 0;
    state.boat.activeArmorIndex = clamp(state.boat.activeArmorIndex, 0, ARMOR_IDS.length);
    state.boat.bombBayState = state.bombBayState;
    state.boat.bombCooldown = state.bombCooldown;
    state.boat.salvoRemaining = state.salvoRemaining;
    state.boat.bombBay = state.bombBay;
    state.boat.tactical ||= {};
    state.boat.engineAudio ||= {state: "idle", rpm: 0, load: 0, damage: 0, turnLoad: 0};
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

function threatGraceActive(world, index) {
  return (finite(world.freeThreatDirector?.graceUntil?.[index]) || 0) > (finite(world.time) || 0);
}

function playerPoint(world, index) {
  const player = world.players?.[index];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat)) || world.boats?.[player.activeBoat] || player;
  return player;
}

function livingPlayers(world) {
  return values(world.players).map((player, index) => ({player, index, point: playerPoint(world, index)})).filter(({player, index, point}) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && point && !threatGraceActive(world, index));
}

function nearestPlayer(world, source) {
  return livingPlayers(world).sort((a, b) => distance(source, a.point) - distance(source, b.point))[0] || null;
}

function spawnPoint(anchor) {
  const leftSpace = clamp(finite(anchor?.x, 210) - WORLD_BOUNDS.minX, 0, 999);
  const rightSpace = clamp(WORLD_BOUNDS.maxX - finite(anchor?.x, 210), 0, 999);
  const x = rightSpace >= leftSpace ? WORLD_BOUNDS.maxX - 4 : WORLD_BOUNDS.minX + 4;
  return {x, y: clamp(finite(anchor?.y, 180) + 72, WORLD_BOUNDS.minY + 8, WORLD_BOUNDS.maxY - 8)};
}

export function startEliteBoatBoss(world, threatEncounterId, anchor = {x: 210, y: 180}, targetPlayer = 0) {
  let previous = ensureEliteBoatBoss(world);
  if (previous.active && previous.threatEncounterId === threatEncounterId && !["completed", "aborted"].includes(previous.phase)) return previous;
  if (previous.active || previous.commanderId || previous.projectiles.length || previous.bombRequests.length) {
    resetEliteBoatBoss(world, "superseded");
    previous = ensureEliteBoatBoss(world);
  }
  const point = spawnPoint(anchor);
  const sequence = Math.max(1, finite(previous.encounterId) + 1);
  const state = defaultState(world.players?.length || 2);
  state.active = true;
  state.encounterId = sequence;
  state.threatEncounterId = finite(threatEncounterId);
  state.phase = "approaching";
  state.stage = "armor-outer";
  state.startedAt = finite(world.time);
  state.boat = {id: `elite-boat-${state.threatEncounterId || sequence}`, role: "elite-boss", encounterId: sequence, x: point.x, y: point.y, heading: bearing(point, anchor), speed: 8, maxSpeed: ELITE_MAX_SPEED, alive: true, active: true, destroyed: false, targetPlayer, armorLayers: armorLayers(), activeArmorIndex: 0, hull: ELITE_HULL_HP, maxHull: ELITE_HULL_HP, hullState: "protected", turrets: [createTurret("port", "port"), createTurret("starboard", "starboard")], movementMode: "intercept", movementState: "intercept", bombBayState: "closed", bombCooldown: 0, salvoRemaining: 0, bombBay: state.bombBay, ramCooldown: 0, tactical: {primaryTarget: targetPlayer, secondaryTarget: null, encircled: false, protectedSystem: null}, engineAudio: {state: "accelerating", rpm: 0.4, load: 0.6, damage: 0, turnLoad: 0}};
  world.freeEliteBoatBoss = state;
  emit(world, "elite-boss-approach", "После тяжёлого катера в бухту входит элитный корабль. Три слоя брони, две независимые установки и отдельный бомбоотсек готовы к бою.", [0, 1], {encounterId: state.encounterId, threatEncounterId: state.threatEncounterId, x: point.x, y: point.y});
  return state;
}

function clearEliteTargets(world) {
  for (const player of values(world.players)) {
    const combat = player?.combat;
    if (!combat) continue;
    if (String(combat.lockedTargetId || "").startsWith("elite-")) combat.lockedTargetId = null;
    if (String(combat.lastTargetRequestId || "").startsWith("elite-")) combat.lastTargetRequestId = null;
  }
}

export function resetEliteBoatBoss(world, reason = "reset") {
  const state = ensureEliteBoatBoss(world);
  const commanderId = state.commanderId;
  if (commanderId && world.freeHostileActors) {
    world.freeHostileActors.actors = values(world.freeHostileActors.actors).filter(actor => actor.id !== commanderId);
    world.freeHostileActors.projectiles = values(world.freeHostileActors.projectiles).filter(projectile => projectile.actorId !== commanderId);
  }
  if (world.freeMegaBombs) {
    const encounterId = finite(state.encounterId);
    world.freeMegaBombs.projectiles = values(world.freeMegaBombs.projectiles).filter(projectile => finite(projectile?.eliteBossEncounterId) !== encounterId);
  }
  clearEliteTargets(world);
  const nextId = Math.max(0, finite(state.encounterId));
  world.freeEliteBoatBoss = {...defaultState(world.players?.length || 2), encounterId: nextId, cleanupReason: reason, phase: reason === "completed" ? "completed" : "inactive"};
  return world.freeEliteBoatBoss;
}

function activeArmor(boat) { return boat?.armorLayers?.[boat.activeArmorIndex] || null; }
function stageForIndex(index) { return index >= ARMOR_IDS.length ? "hull-exposed" : `armor-${ARMOR_IDS[index]}`; }
function updateArmorStates(boat) { for (let index = 0; index < boat.armorLayers.length; index += 1) { const layer = boat.armorLayers[index]; if (layer.hp <= 0) layer.state = "destroyed"; else if (index === boat.activeArmorIndex) layer.state = "active"; else layer.state = index < boat.activeArmorIndex ? "destroyed" : "protected"; } }

function rememberTactic(state, name, score = 0) {
  const tactical = state.tactical;
  tactical.tacticHistory.push({name, at: finite(state.startedAt), score});
  if (tactical.tacticHistory.length > 16) tactical.tacticHistory.splice(0, tactical.tacticHistory.length - 16);
  tactical.tacticScores[name] = clamp(finite(tactical.tacticScores[name]) * 0.82 + score, -8, 8);
}

function recordDamagePressure(state, sourcePlayer, amount) {
  if (!Number.isInteger(sourcePlayer) || sourcePlayer < 0) return;
  const memory = state.tactical.playerMemory[sourcePlayer];
  if (!memory) return;
  memory.damagePressure = clamp(finite(memory.damagePressure) + amount / 35, 0, 18);
}

function announceArmorDamage(world, state, layer, sourcePlayer) {
  if (layer.hp > layer.maxHp * 0.25 || layer.criticalAnnounced) return;
  layer.criticalAnnounced = true;
  const names = {outer: "Внешний", middle: "Средний", inner: "Внутренний"};
  emit(world, "elite-armor-critical", `${names[layer.id]} слой брони почти разрушен.`, [0, 1], {sourcePlayer, layerId: layer.id, hp: layer.hp, x: state.boat.x, y: state.boat.y});
}

function transitionArmor(world, state, sourcePlayer) {
  const boat = state.boat;
  const destroyed = boat.armorLayers[boat.activeArmorIndex];
  if (!destroyed || destroyed.hp > 0 || destroyed.destroyedAnnounced) return;
  destroyed.destroyedAnnounced = true;
  const names = {outer: "Внешний", middle: "Средний", inner: "Внутренний"};
  emit(world, "elite-armor-destroyed", `${names[destroyed.id]} слой брони уничтожен.`, [0, 1], {sourcePlayer, layerId: destroyed.id, x: boat.x, y: boat.y});
  boat.activeArmorIndex += 1;
  updateArmorStates(boat);
  state.stage = stageForIndex(boat.activeArmorIndex);
  if (boat.activeArmorIndex >= boat.armorLayers.length) {
    boat.hullState = "exposed";
    emit(world, "elite-hull-exposed", "Все три слоя брони уничтожены. Основной корпус открыт. Установки и открывающийся бомбоотсек остаются отдельными системами.", [0, 1], {sourcePlayer, x: boat.x, y: boat.y});
  } else {
    const next = activeArmor(boat);
    emit(world, "elite-armor-next", `Открыт следующий слой брони: ${next.id === "middle" ? "средний" : "внутренний"}.`, [0, 1], {sourcePlayer, layerId: next.id, x: boat.x, y: boat.y});
  }
}

function turretByComponent(boat, component) {
  if (component === "turret-port") return boat.turrets.find(turret => turret.side === "port") || null;
  if (component === "turret-starboard") return boat.turrets.find(turret => turret.side === "starboard") || null;
  return null;
}

function resolveBombBayDetonation(world, state, sourcePlayer, damage) {
  const bay = state.bombBay;
  if (bay.internalDetonationResolved) return;
  bay.internalDetonationResolved = true;
  const exposed = ["opening", "open"].includes(state.bombBayState);
  const phaseWeight = state.bombBayState === "open" ? 0.44 : state.bombBayState === "opening" ? 0.31 : 0.08;
  const damageWeight = clamp(damage / Math.max(1, bay.maxHp), 0, 1) * 0.35;
  const deterministic = ((state.encounterId * 31 + state.tactical.salvoSerial * 17 + Math.round(finite(world.time) * 10)) % 100) / 100;
  const chance = exposed ? clamp(phaseWeight + damageWeight, 0, 0.78) : 0.04;
  if (deterministic > chance) return;
  const hullDamage = 520 + Math.round(clamp(finite(state.salvoRemaining), 0, BOMB_SALVO_SIZE) * 145);
  state.boat.hull = clamp(finite(state.boat.hull) - hullDamage, 0, state.boat.maxHull);
  for (const turret of state.boat.turrets) {
    if (turret.destroyed) continue;
    turret.hp = clamp(finite(turret.hp) - 105, 0, turret.maxHp);
    if (turret.hp <= 0) { turret.destroyed = true; turret.state = "destroyed"; turret.burstRemaining = 0; turret.windup = 0; }
  }
  emit(world, "elite-bomb-bay-internal-detonation", "Боезапас детонировал внутри открытого бомбоотсека. Корпус и соседние системы получили повреждения.", [0, 1], {sourcePlayer, hullDamage, x: state.boat.x, y: state.boat.y});
  if (state.boat.hull <= 0) beginBoatDestruction(world, state, sourcePlayer);
}

export function damageEliteBoatBoss(world, component, amount, sourcePlayer = -1, details = {}) {
  const state = activeEliteBoatBoss(world);
  const boat = state?.boat;
  const raw = Math.max(0, finite(amount));
  if (!boat?.alive || raw <= 0 || !["approaching", "boat-combat"].includes(state.phase)) return false;
  const weapon = String(details.weapon || "unknown");
  const audience = sourcePlayer >= 0 ? [sourcePlayer] : [0, 1];
  const turret = turretByComponent(boat, component);
  if (turret) {
    if (turret.destroyed) return false;
    const before = turret.hp;
    turret.hp = clamp(before - raw, 0, turret.maxHp);
    recordDamagePressure(state, sourcePlayer, before - turret.hp);
    emit(world, "elite-turret-hit", "", audience, {sourcePlayer, component, turretId: turret.id, damage: before - turret.hp, weapon, x: boat.x, y: boat.y});
    if (turret.hp <= 0) {
      turret.destroyed = true; turret.state = "destroyed"; turret.burstRemaining = 0; turret.windup = 0;
      emit(world, "elite-turret-destroyed", `${turret.side === "port" ? "Левая" : "Правая"} установка уничтожена. Оставшееся оружие перестраивает тактику.`, [0, 1], {sourcePlayer, component, turretId: turret.id, x: boat.x, y: boat.y});
    }
    return true;
  }
  if (component === "bomb-bay" || component === state.bombBay.id) {
    const bay = state.bombBay;
    if (bay.destroyed) return false;
    const exposed = ["opening", "open"].includes(state.bombBayState);
    const protection = exposed ? 1 : 0.08;
    const dealt = raw * protection;
    const before = bay.hp;
    bay.hp = clamp(before - dealt, 0, bay.maxHp);
    recordDamagePressure(state, sourcePlayer, before - bay.hp);
    emit(world, exposed ? "elite-bomb-bay-hit" : "elite-bomb-bay-armoured-hit", exposed ? "" : "Закрытые створки почти полностью приняли удар.", audience, {sourcePlayer, damage: before - bay.hp, protected: !exposed, weapon, x: boat.x, y: boat.y});
    if (bay.hp <= 0) {
      bay.destroyed = true; bay.state = "destroyed"; state.salvoRemaining = 0; state.salvoCooldown = 0; state.bombCooldown = Number.POSITIVE_INFINITY; state.bombRequests = []; setBombBayState(state, "destroyed");
      emit(world, "elite-bomb-bay-destroyed", "Бомбоотсек уничтожен. Корабельные бомбы отключены до конца боя.", [0, 1], {sourcePlayer, x: boat.x, y: boat.y});
      resolveBombBayDetonation(world, state, sourcePlayer, raw);
    }
    return true;
  }
  if (weapon === "pistol") {
    emit(world, "armoured-target", "Пистолет не пробивает броню или корпус элитного катера. Выбери установку, открытый бомбоотсек, автомат или мега-бомбу.", audience, {sourcePlayer, component, x: boat.x, y: boat.y});
    return false;
  }
  const layer = activeArmor(boat);
  if (layer) {
    if (component && component !== `armor-${layer.id}` && component !== "armor") {
      emit(world, "elite-target-protected", "Эта часть ещё закрыта текущим слоем брони.", audience, {sourcePlayer, component, activeLayer: layer.id, x: boat.x, y: boat.y});
      return false;
    }
    const before = layer.hp;
    layer.hp = clamp(before - raw, 0, layer.maxHp);
    recordDamagePressure(state, sourcePlayer, before - layer.hp);
    emit(world, "elite-armor-hit", "", audience, {sourcePlayer, layerId: layer.id, damage: before - layer.hp, weapon, x: boat.x, y: boat.y});
    announceArmorDamage(world, state, layer, sourcePlayer);
    transitionArmor(world, state, sourcePlayer);
    return true;
  }
  if (!["hull", "armor"].includes(component || "hull")) return false;
  const before = boat.hull;
  boat.hull = clamp(before - raw, 0, boat.maxHull);
  recordDamagePressure(state, sourcePlayer, before - boat.hull);
  emit(world, "elite-hull-hit", "", audience, {sourcePlayer, component: "hull", damage: before - boat.hull, weapon, x: boat.x, y: boat.y});
  if (boat.hull <= 0) beginBoatDestruction(world, state, sourcePlayer);
  return true;
}

function beginBoatDestruction(world, state, sourcePlayer) {
  if (state.phase === "boat-destroying" || !state.boat?.alive) return;
  const boat = state.boat;
  boat.alive = false; boat.active = false; boat.destroyed = true; boat.speed = 0;
  for (const turret of boat.turrets) { turret.burstRemaining = 0; turret.windup = 0; if (!turret.destroyed) turret.state = "disabled-by-hull"; }
  state.phase = "boat-destroying"; state.deployRemaining = 1.6; state.salvoRemaining = 0; state.projectiles = []; state.bombRequests = [];
  setBombBayState(state, state.bombBay.destroyed ? "destroyed" : "closed");
  clearEliteTargets(world);
  emit(world, "elite-boat-destroyed", "Корпус элитного катера уничтожен. Все корабельные системы остановлены, но командир готовится покинуть обломок.", [0, 1], {sourcePlayer, encounterId: state.encounterId, x: boat.x, y: boat.y});
}

function observePlayers(world, state, dt) {
  const tactical = state.tactical;
  const now = finite(world.time);
  for (const item of livingPlayers(world)) {
    const memory = tactical.playerMemory[item.index];
    const x = finite(item.point.x), y = finite(item.point.y);
    if (memory.lastX !== null && dt > 0) memory.observedSpeed = clamp(distance({x: memory.lastX, y: memory.lastY}, {x, y}) / dt, 0, 45);
    else memory.observedSpeed = clamp(finite(item.point.speed), 0, 45);
    const heading = finite(item.point.heading);
    if (memory.lastHeading !== null && Math.abs(wrapDeg(heading - memory.lastHeading)) > 28) memory.routeChanges += 1;
    memory.lastHeading = heading; memory.observedHeading = heading; memory.lastX = x; memory.lastY = y; memory.lastSeenAt = now;
    const combat = item.player?.combat || {};
    const firing = finite(combat.attackCooldown) > 0 || finite(combat.pistolCooldown) > 0;
    if (firing) { memory.recentFire = clamp(finite(memory.recentFire) + dt * 5, 0, 14); memory.shotsObserved += 1; }
    else memory.recentFire *= Math.exp(-dt * 0.75);
    memory.damagePressure *= Math.exp(-dt * 0.25);
    memory.pursuitPressure *= Math.exp(-dt * 0.45);
  }
}

function updateThreatScores(world, state) {
  const boat = state.boat;
  const players = livingPlayers(world);
  for (const item of players) {
    const memory = state.tactical.playerMemory[item.index];
    const metres = distance(boat, item.point);
    const closing = Math.max(0, memory.observedSpeed - metres * 0.025);
    memory.pursuitPressure = clamp(finite(memory.pursuitPressure) + closing * 0.018, 0, 14);
    memory.threatScore = finite(memory.recentFire) * 1.5 + finite(memory.damagePressure) * 2.2 + finite(memory.pursuitPressure) * 1.1 + clamp((195 - metres) / 22, 0, 6) + (item.player?.mode === "roof" ? 1.2 : 0);
  }
  players.sort((a, b) => state.tactical.playerMemory[b.index].threatScore - state.tactical.playerMemory[a.index].threatScore);
  state.tactical.primaryTarget = players[0]?.index ?? null;
  state.tactical.secondaryTarget = players[1]?.index ?? null;
  if (state.boat) { state.boat.targetPlayer = state.tactical.primaryTarget; state.boat.tactical.primaryTarget = state.tactical.primaryTarget; state.boat.tactical.secondaryTarget = state.tactical.secondaryTarget; }
  return players;
}

function assignTurretTargets(world, state, players) {
  const livingTurrets = state.boat.turrets.filter(turret => !turret.destroyed);
  if (!livingTurrets.length || !players.length) return;
  const primary = players.find(item => item.index === state.tactical.primaryTarget) || players[0];
  const secondary = players.find(item => item.index === state.tactical.secondaryTarget) || null;
  for (let index = 0; index < livingTurrets.length; index += 1) {
    const turret = livingTurrets[index];
    const target = secondary && livingTurrets.length > 1 && index === 1 ? secondary : primary;
    if (turret.targetPlayer !== target.index) turret.lastTargetChangeAt = finite(world.time);
    turret.targetPlayer = target.index;
    turret.tacticalRole = target === primary ? "primary-suppression" : "secondary-denial";
  }
}

function targetForAssignedTurret(world, state, turret) {
  const candidates = livingPlayers(world);
  const assigned = candidates.find(item => item.index === turret.targetPlayer);
  if (assigned) return assigned;
  const fallback = candidates.find(item => item.index === state.tactical.primaryTarget) || candidates[0] || null;
  if (fallback) turret.targetPlayer = fallback.index;
  return fallback;
}

function turretPoint(boat, turret) {
  const forward = headingVector(boat.heading), right = rightVector(boat.heading), side = turret.side === "port" ? -1 : 1;
  return {x: boat.x + forward.x * 3.6 + right.x * side * 3.2, y: boat.y + forward.y * 3.6 + right.y * side * 3.2};
}

function turretAimPoint(world, state, muzzle, turret, target, projectileSerial = 0) {
  const point = target.point;
  const memory = state.tactical.playerMemory[target.index] || createPlayerMemory();
  const movingBoat = ["boat", "roof"].includes(target.player?.mode);
  const observedHeading = movingBoat ? finite(memory.observedHeading, point.heading) : 0;
  const forward = movingBoat ? headingVector(observedHeading) : {x: 0, y: 0};
  const right = movingBoat ? rightVector(observedHeading) : {x: 0, y: 0};
  const observedSpeed = movingBoat ? clamp(finite(memory.observedSpeed, point.speed), 0, 45) : 0;
  const leadSeconds = clamp(distance(muzzle, point) / ELITE_BULLET_SPEED, 0, 1.45);
  const predictionWeight = 0.86 - clamp(memory.routeChanges * 0.018, 0, 0.3);
  const section = turret.side === "port" ? -3.8 : 3.8;
  const lane = ((projectileSerial % 5) - 2) * 0.82 + (turret.side === "port" ? -1.1 : 1.1);
  return {x: clamp(point.x + forward.x * (observedSpeed * leadSeconds * predictionWeight + section) + right.x * lane, 5, 415), y: clamp(point.y + forward.y * (observedSpeed * leadSeconds * predictionWeight + section) + right.y * lane, 5, 315), lane};
}

function spawnTurretBullet(world, state, boat, turret, target) {
  if (state.projectiles.length >= BULLET_LIMIT || !target?.point || threatGraceActive(world, target.index)) return false;
  const muzzle = turretPoint(boat, turret), serial = state.nextProjectileId++, predicted = turretAimPoint(world, state, muzzle, turret, target, serial);
  const angle = bearing(muzzle, predicted) * Math.PI / 180;
  const boatVelocity = headingVector(boat.heading), inherited = finite(boat.speed) * BULLET_INHERITANCE;
  const vx = Math.sin(angle) * ELITE_BULLET_SPEED + boatVelocity.x * inherited;
  const vy = -Math.cos(angle) * ELITE_BULLET_SPEED + boatVelocity.y * inherited;
  const speed = Math.hypot(vx, vy), id = `elite-bullet-${state.encounterId}-${serial}`;
  state.projectiles.push({id, turretId: turret.id, targetPlayer: target.index, x: muzzle.x, y: muzzle.y, previousX: muzzle.x, previousY: muzzle.y, sourceX: muzzle.x, sourceY: muzzle.y, vx, vy, speed, mass: BULLET_MASS, energy: 0.5 * BULLET_MASS * speed * speed, spawnedAt: finite(world.time), ttl: 3.6, aimSection: turret.side === "port" ? "rear" : "front", tacticalLane: predicted.lane, inheritedBoatVelocity: inherited, flybyPlayers: [], endReason: null});
  emit(world, "elite-turret-shot", "", [0, 1], {projectileId: id, turretId: turret.id, side: turret.side, targetPlayer: target.index, aimSection: turret.side === "port" ? "rear" : "front", tacticalRole: turret.tacticalRole, x: muzzle.x, y: muzzle.y, heading: bearing(muzzle, predicted), speed});
  return true;
}

function updateTurrets(world, state, dt) {
  const boat = state.boat;
  boat.turrets.forEach(turret => {
    if (turret.destroyed || !boat.alive) return;
    turret.fireCooldown = Math.max(0, finite(turret.fireCooldown) - dt);
    turret.shotCooldown = Math.max(0, finite(turret.shotCooldown) - dt);
    const target = targetForAssignedTurret(world, state, turret);
    if (!target) { turret.burstRemaining = 0; turret.windup = 0; turret.state = "holding"; return; }
    const muzzle = turretPoint(boat, turret);
    turret.heading = bearing(muzzle, turretAimPoint(world, state, muzzle, turret, target));
    const metres = distance(boat, target.point);
    if (metres > 235 || metres < 15) { turret.burstRemaining = 0; turret.windup = 0; turret.state = "tracking"; return; }
    if (turret.windup > 0) {
      turret.windup = Math.max(0, turret.windup - dt); turret.state = "spinning";
      if (turret.windup <= 0) { turret.burstRemaining = TURRET_BURST_SIZE; turret.shotCooldown = 0; turret.state = "firing"; }
      return;
    }
    if (turret.burstRemaining > 0) {
      turret.state = "firing";
      if (turret.shotCooldown > 0) return;
      if (!spawnTurretBullet(world, state, boat, turret, target)) { turret.burstRemaining = 0; turret.fireCooldown = 0.8; return; }
      turret.burstRemaining -= 1; turret.shotCooldown = TURRET_SHOT_INTERVAL;
      if (turret.burstRemaining <= 0) { turret.fireCooldown = turret.side === "port" ? 1.55 : 1.78; turret.state = "cooling"; emit(world, "elite-turret-burst-end", "", [0, 1], {turretId: turret.id, side: turret.side, x: boat.x, y: boat.y}); }
      return;
    }
    if (turret.fireCooldown <= 0) {
      turret.windup = turret.side === "port" ? 0.34 : 0.42; turret.state = "spinning";
      emit(world, "elite-turret-windup", `${turret.side === "port" ? "Левая" : "Правая"} установка раскручивается.`, [target.index], {turretId: turret.id, side: turret.side, targetPlayer: target.index, tacticalRole: turret.tacticalRole, eta: turret.windup, x: boat.x, y: boat.y});
    }
  });
}

function segmentHit(from, to, target, radius) {
  const dx = to.x - from.x, dy = to.y - from.y, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return distance(from, target) <= radius;
  const t = clamp(((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(target.x - (from.x + dx * t), target.y - (from.y + dy * t)) <= radius;
}

function occupantsForBoat(world, boat) {
  const occupants = [];
  for (let index = 0; index < values(world.players).length; index += 1) {
    const player = world.players[index];
    if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false || threatGraceActive(world, index)) continue;
    if (String(player.activeBoat) === String(boat.id) || boat.driver === index || (boat.owner === index && ["boat", "roof"].includes(player.mode))) occupants.push(index);
  }
  return [...new Set(occupants)];
}

function endProjectile(world, state, projectile, reason, point = projectile) {
  projectile.endReason = reason;
  const event = {id: projectile.id, reason, x: finite(point.x, projectile.x), y: finite(point.y, projectile.y), at: finite(world.time)};
  state.projectileEndEvents.push(event);
  if (state.projectileEndEvents.length > 48) state.projectileEndEvents.splice(0, state.projectileEndEvents.length - 48);
  emit(world, "elite-bullet-ended", "", [0, 1], {projectileId: projectile.id, turretId: projectile.turretId, reason, x: event.x, y: event.y});
}

function applyBoatPenetration(world, projectile, boat, helpers) {
  const oldHull = clamp(boat.hull, 0, 100), ratio = oldHull / 100, hullDamage = 2.8;
  boat.hull = clamp(oldHull - hullDamage, 0, 100); boat.leak = clamp(finite(boat.leak) + 0.12, 0, 24);
  const occupants = occupantsForBoat(world, boat);
  for (const index of occupants) {
    const player = world.players[index], penetration = player.mode === "roof" ? 1 : clamp(0.18 + (1 - ratio) * 0.7, 0.18, 0.88), humanDamage = 7.2 * penetration;
    helpers?.damagePlayer?.(world, index, humanDamage, {weapon: "elite-automatic", heavy: humanDamage >= 5.2, eventType: "elite-bullet-player-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}, announceHealth: false});
    emit(world, "elite-bullet-penetration", "", [index], {projectileId: projectile.id, turretId: projectile.turretId, targetBoat: boat.id, targetPlayer: index, hullDamage, humanDamage, penetration, hull: boat.hull, health: player.combat?.health, x: boat.x, y: boat.y});
  }
  if (!occupants.length) emit(world, "elite-bullet-boat-hit", "", [boat.owner].filter(Number.isInteger), {projectileId: projectile.id, turretId: projectile.turretId, targetBoat: boat.id, hullDamage, hull: boat.hull, x: boat.x, y: boat.y});
}

function pointObstacleHit(world, from, to) {
  const collections = [...values(world.obstacles), ...values(world.freeObstacles), ...values(world.terrainObstacles)];
  for (const obstacle of collections) { if (!obstacle || obstacle.destroyed) continue; if (segmentHit(from, to, obstacle, Math.max(1, finite(obstacle.radius, 3)))) return obstacle; }
  return null;
}

function updateFlybys(world, projectile, from, to) {
  projectile.flybyPlayers = values(projectile.flybyPlayers);
  for (let index = 0; index < values(world.players).length; index += 1) {
    if (projectile.flybyPlayers.includes(index)) continue;
    const point = playerPoint(world, index), player = world.players[index];
    if (!point || !player?.combat?.alive || threatGraceActive(world, index)) continue;
    if (!segmentHit(from, to, point, BULLET_FLYBY_RADIUS) || segmentHit(from, to, point, 2.2)) continue;
    projectile.flybyPlayers.push(index);
    emit(world, "elite-bullet-flyby", "", [index], {projectileId: projectile.id, turretId: projectile.turretId, x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy, speed: projectile.speed});
  }
}

function normalizeProjectile(projectile, world) {
  projectile.previousX = finite(projectile.previousX, projectile.x); projectile.previousY = finite(projectile.previousY, projectile.y);
  projectile.vx = finite(projectile.vx); projectile.vy = finite(projectile.vy); projectile.speed = Math.hypot(projectile.vx, projectile.vy);
  projectile.mass = Math.max(0.001, finite(projectile.mass, BULLET_MASS)); projectile.energy = Math.max(0, finite(projectile.energy, 0.5 * projectile.mass * projectile.speed * projectile.speed));
  projectile.spawnedAt = finite(projectile.spawnedAt, world.time); projectile.ttl = finite(projectile.ttl, 3.6); projectile.flybyPlayers = values(projectile.flybyPlayers);
  return projectile;
}

function updateProjectiles(world, state, dt, helpers) {
  const survivors = [];
  for (const rawProjectile of state.projectiles) {
    const projectile = normalizeProjectile(rawProjectile, world);
    const from = {x: projectile.x, y: projectile.y}, next = {x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt};
    updateFlybys(world, projectile, from, next);
    let ended = false;
    for (const boat of values(world.boats)) {
      if (!boat || boat.sunk || !segmentHit(from, next, boat, 6.8)) continue;
      const protectedOccupants = occupantsForBoat(world, boat), linkedTargetProtected = Number.isInteger(projectile.targetPlayer) && threatGraceActive(world, projectile.targetPlayer);
      if (linkedTargetProtected && !protectedOccupants.length) continue;
      applyBoatPenetration(world, projectile, boat, helpers); endProjectile(world, state, projectile, "boat-impact", boat); ended = true; break;
    }
    if (ended) continue;
    for (let index = 0; index < values(world.players).length; index += 1) {
      const player = world.players[index];
      if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false || threatGraceActive(world, index) || !["foot", "swim", "roof"].includes(player.mode)) continue;
      if (!segmentHit(from, next, player, 1.9)) continue;
      helpers?.damagePlayer?.(world, index, 7.2, {weapon: "elite-automatic", heavy: true, eventType: "elite-bullet-player-hit", sourcePoint: {x: projectile.sourceX, y: projectile.sourceY}, announceHealth: false});
      emit(world, "elite-bullet-direct-hit", "", [index], {projectileId: projectile.id, turretId: projectile.turretId, damage: 7.2, x: player.x, y: player.y}); endProjectile(world, state, projectile, "target-impact", player); ended = true; break;
    }
    if (ended) continue;
    const obstacle = pointObstacleHit(world, from, next);
    if (obstacle) { endProjectile(world, state, projectile, "terrain-impact", obstacle); continue; }
    projectile.previousX = projectile.x; projectile.previousY = projectile.y; projectile.x = next.x; projectile.y = next.y; projectile.ttl -= dt;
    projectile.energy = Math.max(0, projectile.energy * Math.exp(-BULLET_ENERGY_LOSS_PER_SECOND * dt)); projectile.speed = Math.hypot(projectile.vx, projectile.vy);
    if (projectile.x < -10 || projectile.x > 430 || projectile.y < -10 || projectile.y > 330) { endProjectile(world, state, projectile, "boundary-impact", projectile); continue; }
    if (projectile.energy <= 0.001) { endProjectile(world, state, projectile, "energy-depleted", projectile); continue; }
    if (projectile.ttl <= 0) { endProjectile(world, state, projectile, "lifetime-expired", projectile); continue; }
    survivors.push(projectile);
  }
  state.projectiles = survivors;
}

function classifySystems(state) {
  const boat = state.boat, livingTurrets = boat.turrets.filter(turret => !turret.destroyed), criticalTurret = livingTurrets.filter(turret => turret.hp < turret.maxHp * 0.28).sort((a, b) => a.hp - b.hp)[0] || null;
  const bombBayExposed = ["opening", "open"].includes(state.bombBayState), bombBayAlive = !state.bombBay.destroyed;
  return {livingTurrets, criticalTurret, bombBayExposed, bombBayAlive, disarmed: livingTurrets.length === 0 && !bombBayAlive};
}

function evaluateEncirclement(state, players) {
  if (players.length < 2) return false;
  const boat = state.boat, a = bearing(boat, players[0].point), b = bearing(boat, players[1].point);
  return Math.abs(wrapDeg(a - b)) > 105 && distance(boat, players[0].point) < 155 && distance(boat, players[1].point) < 155;
}

function chooseMovement(world, state, players) {
  const boat = state.boat, tactical = state.tactical, systems = classifySystems(state);
  const primary = players.find(item => item.index === tactical.primaryTarget) || players[0] || null;
  if (!primary) return {state: "holding-fire", point: boat, speed: 0};
  const metres = distance(boat, primary.point), now = finite(world.time), encircled = evaluateEncirclement(state, players);
  tactical.teamMemory.encirclement = clamp(tactical.teamMemory.encirclement * 0.88 + (encircled ? 1 : 0), 0, 8); boat.tactical.encircled = encircled;
  const edgeMargin = 22, edge = boat.x < WORLD_BOUNDS.minX + edgeMargin || boat.x > WORLD_BOUNDS.maxX - edgeMargin || boat.y < WORLD_BOUNDS.minY + edgeMargin || boat.y > WORLD_BOUNDS.maxY - edgeMargin;
  if (edge) return {state: "boundary-recovery", point: {x: 210, y: 194}, speed: 20};
  if (encircled && now - tactical.teamMemory.lastBreakoutAt > 2.5) {
    tactical.teamMemory.lastBreakoutAt = now; tactical.movementSide *= -1;
    const a = players[0].point, b = players[1].point, midpoint = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, awayHeading = bearing(midpoint, boat) + tactical.movementSide * 34, vector = headingVector(awayHeading);
    rememberTactic(state, "break-encirclement", 0.4);
    return {state: "break-encirclement", point: {x: clamp(boat.x + vector.x * 110, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(boat.y + vector.y * 110, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: boat.maxSpeed};
  }
  if (systems.criticalTurret || systems.bombBayExposed) {
    const threatenedSide = systems.criticalTurret?.side, protectTurn = threatenedSide === "port" ? 76 : threatenedSide === "starboard" ? -76 : tactical.movementSide * 62, heading = bearing(primary.point, boat) + protectTurn, vector = headingVector(heading), protectedSystem = systems.criticalTurret?.id || (systems.bombBayExposed ? state.bombBay.id : null);
    boat.tactical.protectedSystem = protectedSystem; rememberTactic(state, "protect-system", 0.2);
    return {state: "protect-system", point: {x: clamp(boat.x + vector.x * 120, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(boat.y + vector.y * 120, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: Math.max(20, boat.speed)};
  }
  boat.tactical.protectedSystem = null;
  if (systems.disarmed) {
    if (tactical.disarmedSince === null) tactical.disarmedSince = now;
    const canRam = metres < 36 && boat.hull > boat.maxHull * 0.38 && boat.ramCooldown <= 0;
    if (canRam) return {state: "physical-ram", point: primary.point, speed: boat.maxSpeed};
    const away = bearing(primary.point, boat) + tactical.movementSide * 38, vector = headingVector(away);
    return {state: "disarmed-survival", point: {x: clamp(boat.x + vector.x * 125, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(boat.y + vector.y * 125, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: boat.maxSpeed};
  }
  tactical.disarmedSince = null;
  if (metres < 54) {
    const away = bearing(primary.point, boat) + tactical.movementSide * 42, vector = headingVector(away);
    return {state: "break-away", point: {x: clamp(boat.x + vector.x * 110, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(boat.y + vector.y * 110, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: boat.maxSpeed};
  }
  const targetForward = headingVector(primary.point.heading), observedSpeed = state.tactical.playerMemory[primary.index]?.observedSpeed ?? finite(primary.point.speed), predicted = {x: clamp(primary.point.x + targetForward.x * observedSpeed * 2.1, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(primary.point.y + targetForward.y * observedSpeed * 2.1, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)};
  if (metres > 185) return {state: "hard-intercept", point: predicted, speed: boat.maxSpeed};
  const orbitHeading = bearing(primary.point, boat) + tactical.movementSide * (metres > 125 ? 48 : 78), orbit = headingVector(orbitHeading), radius = metres > 125 ? 96 : 108;
  return {state: metres > 125 ? "flanking-intercept" : "adaptive-orbit", point: {x: clamp(predicted.x + orbit.x * radius, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX), y: clamp(predicted.y + orbit.y * radius, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY)}, speed: metres > 125 ? 20.5 : 17.5};
}

function applyMovement(world, state, decision, dt) {
  const boat = state.boat, oldHeading = finite(boat.heading), wantedHeading = bearing(boat, decision.point), turnRate = decision.state === "break-encirclement" ? 165 : 132;
  boat.heading = wrapDeg(oldHeading + clamp(wrapDeg(wantedHeading - oldHeading), -turnRate * dt, turnRate * dt));
  boat.speed += clamp(decision.speed - finite(boat.speed), -16 * dt, 12 * dt); boat.movementMode = decision.state; boat.movementState = decision.state; state.tactical.movementState = decision.state;
  const vector = headingVector(boat.heading), next = {x: boat.x + vector.x * boat.speed * dt, y: boat.y + vector.y * boat.speed * dt}, hitX = next.x < WORLD_BOUNDS.minX || next.x > WORLD_BOUNDS.maxX, hitY = next.y < WORLD_BOUNDS.minY || next.y > WORLD_BOUNDS.maxY;
  if (hitX || hitY) {
    const impactSpeed = boat.speed; boat.x = clamp(next.x, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX); boat.y = clamp(next.y, WORLD_BOUNDS.minY, WORLD_BOUNDS.maxY); boat.heading = wrapDeg(boat.heading + (hitX ? 118 : -118)); boat.speed = Math.max(7, boat.speed * 0.55);
    const hullDamage = impactSpeed > 17 ? 35 : impactSpeed > 11 ? 12 : 0;
    if (hullDamage > 0) boat.hull = clamp(boat.hull - hullDamage, 0, boat.maxHull);
    state.tactical.boundaryContacts += 1; state.tactical.lastBoundaryHeading = oldHeading;
    emit(world, "elite-boat-boundary-impact", "", [0, 1], {x: boat.x, y: boat.y, speed: impactSpeed, hullDamage, reason: "boundary-impact"});
    if (boat.hull <= 0) beginBoatDestruction(world, state, -1);
  } else { boat.x = next.x; boat.y = next.y; }
  const turnLoad = clamp(Math.abs(wrapDeg(boat.heading - oldHeading)) / Math.max(0.001, turnRate * dt), 0, 1), speedRatio = clamp(boat.speed / Math.max(1, boat.maxSpeed), 0, 1), damageRatio = 1 - clamp(boat.hull / Math.max(1, boat.maxHull), 0, 1);
  let engineState = "cruise";
  if (speedRatio < 0.1) engineState = "idle"; else if (decision.speed - boat.speed > 2) engineState = "accelerating"; else if (boat.speed > boat.maxSpeed * 0.92) engineState = "full-power"; else if (turnLoad > 0.55) engineState = "hard-turn"; else if (decision.speed < boat.speed - 2) engineState = "decelerating"; if (damageRatio > 0.65) engineState = "damaged";
  boat.engineAudio = {state: engineState, rpm: clamp(0.18 + speedRatio * 0.82, 0, 1), load: clamp(speedRatio * 0.65 + turnLoad * 0.55, 0, 1), damage: damageRatio, turnLoad};
  if (state.phase === "approaching") {
    const target = nearestPlayer(world, boat);
    if (target?.point && distance(boat, target.point) <= 195) { state.phase = "boat-combat"; emit(world, "elite-boss-combat-start", "Элитный катер вошёл в боевую дистанцию. Его установки и бомбоотсек действуют как отдельные системы.", [0, 1], {encounterId: state.encounterId, x: boat.x, y: boat.y}); }
  }
}

function updateRam(world, state, dt, helpers) {
  const boat = state.boat; boat.ramCooldown = Math.max(0, finite(boat.ramCooldown) - dt);
  if (boat.movementState !== "physical-ram" || boat.ramCooldown > 0) return;
  const targetIndex = state.tactical.primaryTarget;
  if (!Number.isInteger(targetIndex)) return;
  const point = playerPoint(world, targetIndex);
  if (!point || distance(boat, point) > RAM_RANGE) return;
  const playerBoat = values(world.boats).find(candidate => String(candidate?.id) === String(world.players?.[targetIndex]?.activeBoat) || candidate?.driver === targetIndex);
  if (playerBoat && !playerBoat.sunk) { playerBoat.hull = clamp(finite(playerBoat.hull, 100) - RAM_DAMAGE_TO_TARGET, 0, 100); playerBoat.leak = clamp(finite(playerBoat.leak) + 1.8, 0, 24); }
  else helpers?.damagePlayer?.(world, targetIndex, 18, {weapon: "elite-ram", heavy: true, eventType: "elite-ram-player-hit", sourcePoint: {x: boat.x, y: boat.y}, announceHealth: true});
  boat.hull = clamp(boat.hull - RAM_SELF_DAMAGE, 0, boat.maxHull); boat.speed *= 0.45; boat.heading = wrapDeg(boat.heading + state.tactical.movementSide * 82); boat.ramCooldown = RAM_COOLDOWN_SECONDS;
  emit(world, "elite-ram-impact", "", [0, 1], {targetPlayer: targetIndex, targetBoat: playerBoat?.id || null, targetDamage: RAM_DAMAGE_TO_TARGET, selfDamage: RAM_SELF_DAMAGE, x: boat.x, y: boat.y});
  if (boat.hull <= 0) beginBoatDestruction(world, state, targetIndex);
}

function deterministicUnit(state, salt = 0) { const value = (state.encounterId * 73856093 + state.tactical.salvoSerial * 19349663 + salt * 83492791) >>> 0; return (value % 10000) / 10000; }

function buildSalvoPlan(state, players) {
  const roles = ["precise", "lead", "route-denial"];
  if (players.length > 1) roles.push("split-players"); else roles.push("retreat-denial");
  const offset = Math.floor(deterministicUnit(state, 1) * roles.length), plan = [];
  for (let index = 0; index < BOMB_SALVO_SIZE; index += 1) plan.push(roles[(offset + index) % roles.length]);
  if (deterministicUnit(state, 2) > 0.56) plan.reverse();
  return plan;
}

function tacticalBombPoint(state, role, players) {
  const primary = players.find(item => item.index === state.tactical.primaryTarget) || players[0] || null, secondary = players.find(item => item.index === state.tactical.secondaryTarget) || null;
  if (!primary) return null;
  const memory = state.tactical.playerMemory[primary.index] || createPlayerMemory(), forward = headingVector(memory.observedHeading), right = rightVector(memory.observedHeading), jitter = (deterministicUnit(state, state.tactical.salvoPlanIndex + 11) - 0.5) * 4;
  if (role === "precise") return {x: primary.point.x + right.x * jitter, y: primary.point.y + right.y * jitter};
  if (role === "lead") return {x: primary.point.x + forward.x * memory.observedSpeed * 1.35 + right.x * jitter, y: primary.point.y + forward.y * memory.observedSpeed * 1.35 + right.y * jitter};
  if (role === "route-denial") return {x: primary.point.x + forward.x * 22 + right.x * state.tactical.movementSide * 9, y: primary.point.y + forward.y * 22 + right.y * state.tactical.movementSide * 9};
  if (role === "split-players" && secondary) return {x: (primary.point.x + secondary.point.x) / 2, y: (primary.point.y + secondary.point.y) / 2};
  return {x: primary.point.x - forward.x * 14 + right.x * state.tactical.movementSide * 7, y: primary.point.y - forward.y * 14 + right.y * state.tactical.movementSide * 7};
}

function requestBomb(world, state, source, target, sourceType, role, targetPlayer = null) {
  if (!source || !target || state.bombRequests.length >= BOMB_REQUEST_LIMIT) return false;
  const id = `elite-bomb-request-${state.encounterId}-${state.nextBombRequestId++}`, sourceVelocity = headingVector(source.heading);
  state.bombRequests.push({id, sourceType, sourceId: source.id, x: source.x, y: source.y, heading: bearing(source, target), targetX: clamp(target.x, 5, 415), targetY: clamp(target.y, 5, 315), targetPlayer, tacticalRole: role, createdAt: finite(world.time), sourceVx: sourceVelocity.x * finite(source.speed) * 0.42, sourceVy: sourceVelocity.y * finite(source.speed) * 0.42, eliteBossEncounterId: state.encounterId});
  return true;
}

function closeBombBay(world, state, announce = true) {
  if (["closed", "closing", "destroyed"].includes(state.bombBayState)) return;
  setBombBayState(state, "closing", BOMB_BAY_CLOSE_SECONDS);
  if (announce) emit(world, "elite-bomb-bay-closing", "Бомбоотсек закрывается. Перезарядка около десяти секунд.", [0, 1], {x: state.boat.x, y: state.boat.y, reload: ELITE_BOMB_RELOAD_SECONDS});
}

function updateBombSalvo(world, state, dt, players) {
  const boat = state.boat, bay = state.bombBay;
  if (bay.destroyed) { state.salvoRemaining = 0; state.bombRequests = []; setBombBayState(state, "destroyed"); return; }
  state.bombCooldown = Math.max(0, finite(state.bombCooldown) - dt); state.salvoCooldown = Math.max(0, finite(state.salvoCooldown) - dt); state.bombBayTimer = Math.max(0, finite(state.bombBayTimer) - dt);
  boat.bombCooldown = state.bombCooldown; boat.salvoRemaining = state.salvoRemaining; boat.bombBayState = state.bombBayState;
  if (!boat.alive || !["approaching", "boat-combat"].includes(state.phase)) { state.salvoRemaining = 0; setBombBayState(state, "closed"); return; }
  const primary = players.find(item => item.index === state.tactical.primaryTarget) || players[0] || null;
  if (!primary?.point) { state.salvoRemaining = 0; if (["opening", "open"].includes(state.bombBayState)) closeBombBay(world, state, false); if (state.bombBayState === "closing" && state.bombBayTimer <= 0) setBombBayState(state, "closed"); return; }
  if (state.bombBayState === "closing") { if (state.bombBayTimer <= 0) { setBombBayState(state, "closed"); emit(world, "elite-bomb-bay-closed", "Бомбоотсек закрыт.", [0, 1], {x: boat.x, y: boat.y}); } return; }
  if (state.bombBayState === "opening") {
    if (state.bombBayTimer > 0) return;
    setBombBayState(state, "open"); state.salvoRemaining = BOMB_SALVO_SIZE; state.salvoCooldown = 0; state.tactical.salvoSerial += 1; state.tactical.salvoPlan = buildSalvoPlan(state, players); state.tactical.salvoPlanIndex = 0;
    emit(world, "elite-bomb-salvo", "Бомбоотсек открыт. Начинается смешанный залп физических бомб.", [primary.index], {sourceId: boat.id, targetPlayer: primary.index, count: BOMB_SALVO_SIZE, roles: [...state.tactical.salvoPlan], x: boat.x, y: boat.y});
  }
  if (state.bombBayState === "open") {
    if (state.salvoRemaining <= 0) { state.bombCooldown = ELITE_BOMB_RELOAD_SECONDS; boat.bombCooldown = state.bombCooldown; closeBombBay(world, state); return; }
    if (state.salvoCooldown > 0) return;
    const role = state.tactical.salvoPlan[state.tactical.salvoPlanIndex] || "precise", point = tacticalBombPoint(state, role, players);
    if (point && requestBomb(world, state, boat, point, "elite-boat", role, primary.index)) {
      state.salvoRemaining -= 1; state.salvoCooldown = BOMB_SALVO_INTERVAL * (0.86 + deterministicUnit(state, state.tactical.salvoPlanIndex + 30) * 0.28); state.tactical.salvoPlanIndex += 1; boat.salvoRemaining = state.salvoRemaining;
      emit(world, "elite-bomb-launch", "", [0, 1], {sourceId: boat.id, targetPlayer: primary.index, tacticalRole: role, remainingInSalvo: state.salvoRemaining, x: boat.x, y: boat.y});
    }
    if (state.salvoRemaining <= 0) { state.bombCooldown = ELITE_BOMB_RELOAD_SECONDS; boat.bombCooldown = state.bombCooldown; closeBombBay(world, state); }
    return;
  }
  if (state.bombCooldown > 0 || state.bombRequests.length > 2) return;
  const metres = distance(boat, primary.point);
  if (metres < 42 || metres > 205) return;
  setBombBayState(state, "opening", BOMB_BAY_OPEN_SECONDS);
  emit(world, "elite-bomb-bay-opening", "", [0, 1], {sourceId: boat.id, targetPlayer: primary.index, eta: BOMB_BAY_OPEN_SECONDS, x: boat.x, y: boat.y});
}

function deployCommander(world, state) {
  if (state.commanderSpawned) return;
  state.commanderSpawned = true; state.phase = "commander-deploying";
  const boat = state.boat, target = nearestPlayer(world, boat)?.index ?? 0, commander = addEliteCommander(world, {id: boat.id, x: boat.x, y: boat.y, heading: boat.heading}, target, state.encounterId);
  state.commanderId = commander.id; state.phase = "commander-combat";
  emit(world, "elite-commander-deployed", "Из уничтоженного корабля физически высадился элитный командир.", [0, 1], {commanderId: commander.id, encounterId: state.encounterId, x: commander.x, y: commander.y});
}

function updateDestruction(world, state, dt) {
  if (state.phase === "boat-destroying") { state.deployRemaining = Math.max(0, finite(state.deployRemaining) - dt); if (state.deployRemaining <= 0) deployCommander(world, state); return; }
  if (state.phase !== "commander-combat") return;
  const commander = hostileActorById(world, state.commanderId);
  if (commander) return;
  if (!state.completionAnnounced) {
    state.completionAnnounced = true; state.active = false; state.phase = "completed"; state.completedAt = world.time; state.rewardReady = true; state.projectiles = []; state.bombRequests = []; clearEliteTargets(world);
    emit(world, "elite-boss-completed", "Элитный командир повержен. Текущая угроза полностью завершена.", [0, 1], {encounterId: state.encounterId, x: state.boat?.x, y: state.boat?.y});
  }
}

export function updateEliteBoatBoss(world, dt, helpers = {}) {
  const state = ensureEliteBoatBoss(world), seconds = clamp(dt, 0, 0.1);
  if (["boat-combat", "approaching"].includes(state.phase) && state.boat?.alive) {
    observePlayers(world, state, seconds);
    const players = updateThreatScores(world, state);
    state.tactical.decisionCooldown = Math.max(0, finite(state.tactical.decisionCooldown) - seconds);
    if (state.tactical.decisionCooldown <= 0) { assignTurretTargets(world, state, players); state.tactical.decisionCooldown = DECISION_INTERVAL_SECONDS; }
    const decision = chooseMovement(world, state, players);
    applyMovement(world, state, decision, seconds);
    updateTurrets(world, state, seconds);
    updateProjectiles(world, state, seconds, helpers);
    updateBombSalvo(world, state, seconds, players);
    updateRam(world, state, seconds, helpers);
  } else if (state.projectiles.length) state.projectiles = [];
  updateDestruction(world, state, seconds);
  return state;
}

export function eliteBossCombatTargets(world, attackerIndex) {
  const state = activeEliteBoatBoss(world), boat = state?.boat;
  if (!boat?.alive || !["approaching", "boat-combat"].includes(state.phase)) return [];
  const targets = [], layer = activeArmor(boat);
  if (layer) targets.push({id: `elite-armor-${layer.id}`, kind: "eliteArmor", component: `armor-${layer.id}`, layerId: layer.id, point: boat, label: `элитный катер, ${layer.id === "outer" ? "внешний" : layer.id === "middle" ? "средний" : "внутренний"} слой брони`, assigned: boat.targetPlayer === attackerIndex});
  else targets.push({id: "elite-hull", kind: "eliteHull", component: "hull", point: boat, label: "элитный катер, открытый корпус", assigned: boat.targetPlayer === attackerIndex});
  for (const turret of boat.turrets) {
    if (turret.destroyed) continue;
    targets.push({id: turret.id, kind: "eliteTurret", component: `turret-${turret.side}`, turretId: turret.id, point: boat, label: `элитный катер, ${turret.side === "port" ? "левая" : "правая"} скорострельная установка`, assigned: turret.targetPlayer === attackerIndex});
  }
  if (!state.bombBay.destroyed && ["opening", "open"].includes(state.bombBayState)) targets.push({id: state.bombBay.id, kind: "eliteBombBay", component: "bomb-bay", bombBayId: state.bombBay.id, point: boat, label: "элитный катер, открытый бомбоотсек", assigned: boat.targetPlayer === attackerIndex});
  return targets;
}

export function eliteBossCompleted(world) { const state = ensureEliteBoatBoss(world); return state.phase === "completed" && state.rewardReady; }
export function consumeEliteBossCompletion(world) { const state = ensureEliteBoatBoss(world); if (!eliteBossCompleted(world)) return false; state.rewardReady = false; return true; }
