"use strict";

import {applyCombatAiModelV166} from "./free-roam-combat-ai-model-v166.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const CUSTOM_PHASES = new Set([
  "breach-escaping-v166",
  "breach-stopping-v166",
  "breach-repairing-v166",
  "breach-returning-v166",
]);

function ensureState(world) {
  world.freeCombatAiV167 ||= {frame: null};
  return world.freeCombatAiV167;
}

function targetAlive(world, targetPlayer) {
  const player = world.players?.[targetPlayer];
  return Boolean(world.freeActivities?.presence?.[targetPlayer] !== false && player?.combat?.alive);
}

function prepareOverlay(world) {
  const state = ensureState(world);
  state.frame = {
    eventStart: world.events?.length || 0,
    actorCooldowns: {},
    phase: world.freeCombatAiV164?.heavy?.phase || null,
  };
  for (const actor of [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]) {
    if (!actor?.active || actor.destroyed) continue;
    state.frame.actorCooldowns[String(actor.id)] = Number(actor.fireCooldown) || 0;
  }
  return state;
}

function livingPoints(world) {
  return (world.players || [])
    .map((player, index) => {
      if (world.freeActivities?.presence?.[index] === false || !player?.combat?.alive) return null;
      if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
      return player;
    })
    .filter(Boolean);
}

function bombReachableSafePoint(world, boat) {
  const living = livingPoints(world);
  if (!living.length) return {x: clamp(boat.x, 24, 396), y: clamp(boat.y, 96, 300)};
  const candidates = [];
  for (const x of [24, 70, 125, 180, 240, 300, 350, 396]) {
    for (const y of [96, 130, 180, 235, 285, 300]) candidates.push({x, y});
  }
  const scored = candidates.map(point => {
    const nearest = Math.min(...living.map(actor => distance(point, actor)));
    return {point, nearest, travel: distance(point, boat)};
  });
  const preferred = scored
    .filter(item => item.nearest >= 228 && item.nearest <= 300 && item.travel >= 24)
    .sort((left, right) => right.nearest - left.nearest || right.travel - left.travel)[0];
  if (preferred) return preferred.point;
  const reachable = scored
    .filter(item => item.nearest <= 315 && item.travel >= 20)
    .sort((left, right) => right.nearest - left.nearest || right.travel - left.travel)[0];
  return reachable?.point || scored.sort((left, right) => left.nearest - right.nearest)[0]?.point || {x: boat.x, y: boat.y};
}

function keepHeavySelectable(world, heavy, boat) {
  if (!CUSTOM_PHASES.has(heavy?.phase) || !boat || boat.destroyed || Number(boat.hull) <= 0) return;
  boat.active = true;
  boat.destroyed = false;
  if (world.freeHeavyPursuer) world.freeHeavyPursuer.active = true;
}

function keepEscapeBombReachable(world, heavy, boat, previousPhase) {
  if (!CUSTOM_PHASES.has(heavy?.phase) || !boat) return;
  const entering = !CUSTOM_PHASES.has(previousPhase) || !heavy.v167ReachableDestination;
  if (!entering && heavy.destination) return;
  const point = bombReachableSafePoint(world, boat);
  heavy.destination = point;
  heavy.v167ReachableDestination = {x: point.x, y: point.y};
}

function normalizeCooldown(value, fallback) {
  const number = Number(value) || 0;
  return number > 30 ? fallback : Math.max(0, number);
}

function restoreShooterTimers(world, state) {
  void normalizeCooldown;
  const saved = state.frame?.actorCooldowns || {};
  for (const actor of [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]) {
    if (!actor?.active || actor.destroyed) continue;
    const alive = targetAlive(world, Number(actor.targetPlayer));
    if ((Number(actor.fireCooldown) || 0) > 30) {
      const original = Number(saved[String(actor.id)]) || 0;
      actor.fireCooldown = alive ? clamp(original || 0.65, 0.35, 1.25) : 0.9;
    }
    if (!alive) {
      actor.aimRemaining = 0;
      actor.burstRemaining = 0;
      actor.windupRemaining = 0;
    }
  }

  const boats = [
    world.freeActivities?.marauder,
    ...(world.freePursuerSquad?.escorts || []),
    ...(world.freeEnemyBoats?.boats || []),
  ].filter(Boolean);
  for (const boat of boats) {
    if (!boat.active || boat.destroyed) continue;
    const alive = targetAlive(world, Number(boat.targetPlayer));
    if (alive && (Number(boat.fireCooldown) || 0) > 30) boat.fireCooldown = 0.75;
    if (boat.hotfixWeapon && alive && (Number(boat.hotfixWeapon.fireCooldown) || 0) > 30) {
      boat.hotfixWeapon.fireCooldown = 0.75;
    }
  }
}

function accelerateRepair(world, heavy, dt) {
  if (heavy?.phase !== "breach-repairing-v166" || dt <= 0) return;
  const quiet = (Number(world.time) || 0) - (Number(heavy.lastDamageAt) || -999) >= 0.75;
  if (!quiet) return;
  const extra = heavy.repairSystem === "engine" ? 0.28 : 0.42;
  heavy.repairProgress = (Number(heavy.repairProgress) || 0) + dt * extra;
}

function detailedRepairText(world, state, heavy, boat) {
  const start = state.frame?.eventStart || 0;
  for (let index = start; index < (world.events?.length || 0); index += 1) {
    const event = world.events[index];
    if (!event) continue;
    const system = event.system === "engine" ? "двигатель" : event.system === "turret" ? "оружейная установка" : "система";
    const duration = event.system === "engine" ? 7 : 8.5;
    if (event.type === "heavy-system-recovery-v166") {
      event.text = `${system[0].toUpperCase()}${system.slice(1)} тяжёлого катера уничтожена. Прочность ноль. Катер физически уходит или останавливается; пластин осталось ${event.plates ?? heavy.repairPlates}. После полной остановки ремонт займёт около ${Math.round(duration)} секунд. Попадания задерживают ремонт.`;
    } else if (event.type === "heavy-repair-start-v166") {
      event.text = `Начат ремонт: ${system}. Окно около ${Math.round(duration)} секунд. Пока экипаж чинит систему, открытый корпус можно добить; любое попадание откатывает прогресс.`;
    } else if (event.type === "heavy-repair-progress-v166") {
      event.text = `Ремонт: ${system}, ${event.percent} процентов. Корпус катера по-прежнему уязвим.`;
    } else if (event.type === "heavy-repair-complete-v166") {
      const restored = event.system === "engine" ? Math.round(Number(boat.engineHealth) || 0) : Math.round(Number(boat.turretHealth) || 0);
      event.text = `Ремонт завершён: ${system}, восстановлено ${restored} единиц. Пластин осталось ${event.plates ?? heavy.repairPlates}.`;
    } else if (event.type === "heavy-breach-escape-v166") {
      event.text = heavy.repairSystem
        ? `Броня уничтожена. Катер ещё жив и даёт полный газ. Повреждена система: ${heavy.repairSystem === "engine" ? "двигатель" : "оружейная установка"}; после отхода он попробует её починить.`
        : "Броня уничтожена. Катер ещё жив, открытый корпус уязвим. Он даёт полный газ и уходит из радиуса пистолета и автомата, но остаётся достижим мега-бомбой.";
    }
  }
}

function finishOverlay(world, dt) {
  const state = ensureState(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  restoreShooterTimers(world, state);
  if (heavy && boat && !boat.destroyed) {
    keepHeavySelectable(world, heavy, boat);
    keepEscapeBombReachable(world, heavy, boat, state.frame?.phase);
    accelerateRepair(world, heavy, dt);
    detailedRepairText(world, state, heavy, boat);
  }
  state.frame = null;
  return state;
}

export function prepareCombatAiV167Overlay(world) {
  return prepareOverlay(world);
}

export function finishCombatAiV167Overlay(world, dt) {
  return finishOverlay(world, Math.max(0, Number(dt) || 0));
}

export function applyCombatAiModelV167(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) {
    prepareOverlay(world);
    applyCombatAiModelV166(world, 0, helpers);
    return ensureState(world);
  }
  applyCombatAiModelV166(world, dt, helpers);
  return finishOverlay(world, dt);
}
