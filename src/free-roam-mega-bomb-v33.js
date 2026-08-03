"use strict";

import * as base from "./free-roam-mega-bomb-v32.js";
import {catalogForCategory} from "../public/src/free-roam-contract-catalog.js";

export * from "./free-roam-mega-bomb-v32.js";

const MAX_STOCK = 45;
const RELOAD_SECONDS = 5.5;
const FOCUSED_MULTIPLIERS = Object.freeze({
  "heavy-turret": Object.freeze({turret: 1.25, engine: 0.16, hull: 0.18}),
  "heavy-engine": Object.freeze({turret: 0.18, engine: 0.88, hull: 0.18}),
  "heavy-pursuer": Object.freeze({turret: 0.18, engine: 0.16, hull: 0.82}),
  splash: Object.freeze({turret: 0.12, engine: 0.10, hull: 0.34}),
});
const VARIANT_NAMES = Object.freeze(["blockade", "counterattack", "breakthrough"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function generatedSeed(world) {
  const time = Date.now() >>> 0;
  const random = Math.floor(Math.random() * 0x100000000) >>> 0;
  const sequence = Number(world?.freeThreatDirector?.encounterId) || 0;
  return (time ^ random ^ Math.imul(sequence + 1, 0x9e3779b1)) >>> 0;
}

function nextRandom(balance) {
  balance.seed = (Math.imul(balance.seed >>> 0, 1664525) + 1013904223) >>> 0;
  return balance.seed / 0x100000000;
}

function offerFromDefinition(definition) {
  return {
    id: `offer-${definition.id}`,
    definitionId: definition.id,
    category: definition.category,
    label: definition.label,
    description: definition.description,
    creditReward: definition.creditReward,
    scrapReward: definition.scrapReward,
    bonus: definition.bonus,
    threat: definition.threat,
    weight: definition.weight,
    slots: definition.slots,
  };
}

function ensureWorldVariety(world) {
  world.freeBalanceDirector ||= {
    seed: generatedSeed(world),
    offersRandomized: false,
    encounterId: -1,
    variant: null,
    heavyAdjusted: false,
  };
  const balance = world.freeBalanceDirector;
  if (!Number.isFinite(Number(balance.seed))) balance.seed = generatedSeed(world);

  const contracts = world.freeContracts;
  if (contracts && !balance.offersRandomized && !contracts.activeContract) {
    contracts.seed = balance.seed >>> 0;
    contracts.decks = {};
    contracts.history = {};
    contracts.offers = ["normal", "salvage", "dangerous"].map(category => {
      const catalog = catalogForCategory(category);
      const selected = catalog[Math.floor(nextRandom(balance) * catalog.length)] || catalog[0];
      return offerFromDefinition(selected);
    });
    contracts.offerGeneration = Math.max(1, Number(contracts.offerGeneration) || 0);
    balance.offersRandomized = true;
  }
  return balance;
}

function clampStock(world) {
  for (const player of world?.players || []) {
    const combat = player?.combat;
    if (!combat) continue;
    combat.megaBombStock = clamp(Math.floor(Number(combat.megaBombStock) || 0), 0, MAX_STOCK);
    combat.megaBombAmmo = Math.min(25, combat.megaBombStock);
    delete combat.megaBombReserve;
  }
}

function activeThreatBoats(world) {
  const result = [];
  const marauder = world.freeActivities?.marauder;
  if (marauder?.active && !marauder.destroyed) result.push(marauder);
  for (const boat of world.freePursuerSquad?.escorts || []) {
    if (boat?.active !== false && !boat?.destroyed) result.push(boat);
  }
  for (const boat of world.freeEnemyBoats?.boats || []) {
    if (boat?.active !== false && !boat?.destroyed) result.push(boat);
  }
  return result;
}

function arrangeThreatBoats(world, variant) {
  const state = world.freeThreatDirector;
  const anchor = state?.lastPoint || {x: 210, y: 180};
  const boats = activeThreatBoats(world);
  boats.forEach((boat, index) => {
    const angle = (index / Math.max(1, boats.length)) * Math.PI * 2;
    const radius = variant === "blockade" ? 62 + index * 7 : variant === "counterattack" ? 92 + index * 4 : 118 + index * 5;
    boat.x = clamp(anchor.x + Math.sin(angle) * radius, 18, 402);
    boat.y = clamp(anchor.y - Math.cos(angle) * radius, 88, 304);
    boat.speed = variant === "counterattack" ? Math.max(Number(boat.speed) || 0, 4.5) : 0;
    const hull = Number(boat.hull);
    if (Number.isFinite(hull)) {
      const factor = variant === "blockade" ? 1.12 : variant === "counterattack" ? 0.88 : 1;
      boat.hull = Math.max(1, Math.round(hull * factor));
      if (Number.isFinite(Number(boat.maxHull))) boat.maxHull = Math.max(boat.hull, Math.round(boat.maxHull * factor));
    }
  });
}

function beginThreatVariant(world, balance, state) {
  const variant = VARIANT_NAMES[Math.floor(nextRandom(balance) * VARIANT_NAMES.length)];
  balance.encounterId = state.encounterId;
  balance.variant = variant;
  balance.heavyAdjusted = false;
  balance.startedAt = world.time;
  balance.firstWaveCount = activeThreatBoats(world).length;
  arrangeThreatBoats(world, variant);

  if (state.level >= 5) {
    if (variant === "blockade") state.heavyStartsAt = world.time + 16 + nextRandom(balance) * 7;
    else if (variant === "counterattack") state.heavyStartsAt = world.time + 4 + nextRandom(balance) * 3;
    else state.heavyStartsAt = Number.POSITIVE_INFINITY;
  }

  const text = variant === "blockade"
    ? "Вариант угрозы: блокада. Противники занимают проходы и прикрывают друг друга. Тяжёлая цель подойдёт позже."
    : variant === "counterattack"
      ? "Вариант угрозы: контратака. Первая группа идёт на быстрый сближающийся бой, тяжёлая цель появится раньше."
      : "Вариант угрозы: прорыв. Сначала расчисти путь или вырвись из окружения; тяжёлая цель войдёт после потерь первой группы.";
  emit(world, "contract-threat-variant", text, [0, 1], {level: state.level, variant});
}

function updateThreatVariant(world) {
  const state = world.freeThreatDirector;
  if (!state?.active || state.level < 4) return;
  const balance = ensureWorldVariety(world);
  if (balance.encounterId !== state.encounterId) beginThreatVariant(world, balance, state);

  if (state.level >= 5 && balance.variant === "breakthrough" && !state.heavyStarted) {
    const alive = activeThreatBoats(world).length;
    const elapsed = world.time - (Number(balance.startedAt) || world.time);
    const threshold = Math.max(1, Math.floor((Number(balance.firstWaveCount) || 3) / 2));
    if (alive <= threshold || elapsed >= 32) state.heavyStartsAt = world.time;
  }

  const heavy = world.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed && !balance.heavyAdjusted) {
    balance.heavyAdjusted = true;
    if (balance.variant === "blockade") {
      heavy.hull = Math.round(heavy.hull * 1.12);
      heavy.maxHull = Math.max(heavy.hull, Math.round(heavy.maxHull * 1.12));
      heavy.fireCooldown = Math.max(heavy.fireCooldown, 3.2);
    } else if (balance.variant === "counterattack") {
      heavy.hull = Math.round(heavy.hull * 0.84);
      heavy.maxHull = Math.max(heavy.hull, Math.round(heavy.maxHull * 0.84));
      heavy.fireCooldown = Math.min(heavy.fireCooldown, 1.4);
    } else {
      heavy.engineHealth = Math.round(heavy.engineHealth * 0.78);
      heavy.maxEngineHealth = Math.max(heavy.engineHealth, Math.round(heavy.maxEngineHealth * 0.78));
    }
  }
}

function heavyHealth(boat) {
  if (!boat) return null;
  return {
    hull: Number(boat.hull) || 0,
    engine: Number(boat.engineHealth) || 0,
    turret: Number(boat.turretHealth) || 0,
  };
}

function focusedHeavyDamage(world, event, targetId, baseline) {
  const boat = world.freeHeavyPursuer?.boat;
  if (!boat || !baseline || !(Number(event?.heavyDamage) > 0)) return baseline;
  const raw = Number(event.heavyDamage) / 2.79;
  const multipliers = FOCUSED_MULTIPLIERS[targetId] || FOCUSED_MULTIPLIERS.splash;
  const next = {
    hull: clamp(baseline.hull - raw * multipliers.hull, 0, Number(boat.maxHull) || baseline.hull),
    engine: clamp(baseline.engine - raw * multipliers.engine, 0, Number(boat.maxEngineHealth) || baseline.engine),
    turret: clamp(baseline.turret - raw * multipliers.turret, 0, Number(boat.maxTurretHealth) || baseline.turret),
  };

  boat.hull = next.hull;
  boat.engineHealth = next.engine;
  boat.turretHealth = next.turret;
  boat.engineDisabled = next.engine <= 0;
  boat.turretDisabled = next.turret <= 0;
  if (next.turret > 0) {
    boat.burstRemaining = Math.max(0, Number(boat.burstRemaining) || 0);
    boat.aimRemaining = Math.max(0, Number(boat.aimRemaining) || 0);
  }
  if (next.hull > 0) {
    boat.active = true;
    boat.destroyed = false;
    if (world.freeHeavyPursuer) world.freeHeavyPursuer.active = true;
  }

  const component = targetId === "heavy-turret" ? "установка"
    : targetId === "heavy-engine" ? "двигатель"
      : targetId === "heavy-pursuer" ? "корпус" : "тяжёлый катер";
  const remaining = targetId === "heavy-turret" ? next.turret
    : targetId === "heavy-engine" ? next.engine : next.hull;
  const disabled = targetId === "heavy-turret" ? boat.turretDisabled
    : targetId === "heavy-engine" ? boat.engineDisabled : next.hull <= 0;
  emit(world, "mega-bomb-heavy-focused-hit",
    disabled
      ? `Точное попадание: ${component} выведен из строя. Остальные части получили только ударную волну.`
      : `Точное попадание по компоненту: ${component}. Осталось ${Math.round(remaining)}. Добивай автоматом или готовь следующий заход.`,
    [event.sourcePlayer].filter(index => index >= 0), {
      sourcePlayer: event.sourcePlayer,
      projectileId: event.projectileId,
      targetId,
      component,
      remaining: Math.round(remaining),
      x: boat.x,
      y: boat.y,
    });
  return next;
}

function rebalanceHeavyBombEvents(world, eventStart, projectileTargets, before) {
  if (!before) return;
  const newEvents = (world.events || []).slice(eventStart);
  const explosions = newEvents.filter(event => event?.type === "mega-bomb-explosion" && Number(event.heavyDamage) > 0);
  if (!explosions.length) return;

  let baseline = before;
  for (const event of explosions) {
    baseline = focusedHeavyDamage(world, event, projectileTargets.get(String(event.projectileId || "")), baseline);
  }

  const boat = world.freeHeavyPursuer?.boat;
  const keepTurretDestroyed = Boolean(boat?.turretDisabled);
  const keepEngineDestroyed = Boolean(boat?.engineDisabled);
  const keepBoatDestroyed = Boolean(boat?.destroyed || (Number(boat?.hull) || 0) <= 0);
  const prefix = (world.events || []).slice(0, eventStart);
  const filtered = (world.events || []).slice(eventStart).filter(event => {
    if (event?.type === "heavy-component-hit" && event.weapon === "mega-bomb") return false;
    if (event?.type === "heavy-turret-destroyed" && !keepTurretDestroyed) return false;
    if (event?.type === "heavy-engine-destroyed" && !keepEngineDestroyed) return false;
    if (event?.type === "heavy-pursuer-destroyed" && !keepBoatDestroyed) return false;
    return true;
  });
  world.events = [...prefix, ...filtered];
}

export function ensureMegaBombState(world) {
  const state = base.ensureMegaBombState(world);
  ensureWorldVariety(world);
  clampStock(world);
  return state;
}

export function reportMegaBombStatus(world, playerIndex) {
  ensureMegaBombState(world);
  return base.reportMegaBombStatus(world, playerIndex);
}

export function launchMegaBomb(world, playerIndex) {
  ensureMegaBombState(world);
  const launched = base.launchMegaBomb(world, playerIndex);
  if (!launched) return false;
  const combat = world.players?.[playerIndex]?.combat;
  if (combat) combat.megaBombCooldown = Math.max(Number(combat.megaBombCooldown) || 0, RELOAD_SECONDS);
  emit(world, "mega-bomb-reloading", "Пуск выполнен. Перезарядка мегабомбы: примерно шесть секунд.", [playerIndex], {
    sourcePlayer: playerIndex,
    remaining: Math.max(0, Math.floor(Number(combat?.megaBombStock) || 0)),
    reloadSeconds: RELOAD_SECONDS,
  });
  return true;
}

export function stepMegaBombs(world, dt) {
  ensureMegaBombState(world);
  const eventStart = world.events?.length || 0;
  const projectileTargets = new Map((world.freeMegaBombs?.projectiles || []).map(projectile => [
    String(projectile?.id || ""),
    String(projectile?.targetId || ""),
  ]));
  const before = heavyHealth(world.freeHeavyPursuer?.boat);
  base.stepMegaBombs(world, dt);
  rebalanceHeavyBombEvents(world, eventStart, projectileTargets, before);
  updateThreatVariant(world);
  clampStock(world);
}

export function megaBombStatus(world) {
  ensureMegaBombState(world);
  const status = base.megaBombStatus(world);
  status.ammo = (world.players || []).map(player => clamp(Math.floor(Number(player?.combat?.megaBombStock) || 0), 0, MAX_STOCK));
  return status;
}
