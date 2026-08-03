"use strict";

import {applyCombatAiModelV164} from "./free-roam-combat-ai-model-v164.js?v=1";

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
  world.freeCombatAiV165 ||= {frame: null, patrol: {}};
  const state = world.freeCombatAiV165;
  state.patrol ||= {};
  return state;
}

function activeDeadAssignedActors(world) {
  return [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]
    .filter(actor => {
      const target = world.players?.[actor?.targetPlayer];
      return actor?.active && !actor.destroyed && target && !target.combat?.alive;
    });
}

function prepareOverlay(world) {
  const state = ensureState(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  state.frame = {
    eventStart: world.events?.length || 0,
    deadActors: {},
    heavyPhase: heavy?.phase || null,
    heavyPosition: boat ? {x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed} : null,
  };
  for (const actor of activeDeadAssignedActors(world)) {
    state.frame.deadActors[String(actor.id)] = {
      targetPlayer: Number(actor.targetPlayer),
      x: actor.x,
      y: actor.y,
      heading: actor.heading,
      state: actor.state,
      returning: actor.returning,
    };
    actor.burstRemaining = 0;
    actor.aimRemaining = 0;
    actor.windupRemaining = 0;
    actor.fireCooldown = Math.max(999, Number(actor.fireCooldown) || 0);
  }
  if (heavy?.phase === "stopping-v165" && boat) {
    boat.burstRemaining = 0;
    boat.aimRemaining = 0;
    boat.fireCooldown = 999;
    boat.turretDisabled = true;
  }
  return state;
}

function patrolPoint(state, actor, target) {
  const memory = state.patrol[String(actor.id)] ||= {index: 0};
  const offsets = [[14, 4], [4, 14], [-14, -3], [-3, -14]];
  const offset = offsets[memory.index % offsets.length];
  return {
    point: {x: clamp(target.x + offset[0], 5, 415), y: clamp(target.y + offset[1], 5, actor.state === "swim" ? 313 : 70)},
    memory,
  };
}

function restoreDeadSearch(world, state, dt) {
  const savedActors = state.frame?.deadActors || {};
  for (const actor of [...(world.freeHostileActors?.actors || []), ...(world.freeHostileGunners?.gunners || [])]) {
    const saved = savedActors[String(actor?.id)];
    if (!saved || !actor?.active || actor.destroyed) continue;
    const target = world.players?.[saved.targetPlayer];
    if (!target || target.combat?.alive) continue;

    actor.targetPlayer = saved.targetPlayer;
    actor.x = saved.x;
    actor.y = saved.y;
    actor.heading = saved.heading;
    actor.state = saved.state;
    actor.returning = false;
    actor.burstRemaining = 0;
    actor.aimRemaining = 0;
    actor.windupRemaining = 0;
    actor.fireCooldown = Math.max(0.8, Number(actor.fireCooldown) || 0);

    const deathPoint = {x: target.x, y: target.y};
    let destination = deathPoint;
    let patrol = null;
    if (distance(actor, deathPoint) <= 5) {
      const result = patrolPoint(state, actor, deathPoint);
      destination = result.point;
      patrol = result.memory;
    }
    const dx = destination.x - actor.x;
    const dy = destination.y - actor.y;
    const metres = Math.hypot(dx, dy);
    if (metres > 0.001) {
      const speed = actor.elite ? 11.5 : actor.state === "swim" ? 5.2 : 9.2;
      const step = Math.min(metres, speed * dt);
      actor.heading = bearing(actor, destination);
      actor.x = clamp(actor.x + dx / metres * step, 5, 415);
      actor.y = clamp(actor.y + dy / metres * step, 5, actor.state === "swim" ? 313 : 70);
      if (patrol && metres - step <= 2.5) patrol.index = (patrol.index + 1) % 4;
    }
  }
}

function rewriteEngineStopMessage(world, start, boat) {
  for (let index = (world.events?.length || 0) - 1; index >= start; index -= 1) {
    const event = world.events[index];
    if (event?.type !== "heavy-repair-retreat" || event.system !== "engine") continue;
    event.text = "Двигатель тяжёлого катера разрушен. Катер теряет ход и физически останавливается перед ремонтом пластинами.";
    event.x = boat.x;
    event.y = boat.y;
    return;
  }
}

function finishEngineStopping(world, state, dt) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  const frame = state.frame;
  if (!heavy || !boat || !boat.active || boat.destroyed || !frame?.heavyPosition) return;

  if (frame.heavyPhase === "combat" && heavy.phase === "repairing" && heavy.repairSystem === "engine" && boat.engineDisabled) {
    heavy.phase = "stopping-v165";
    heavy.repairProgress = 0;
    heavy.repairQuarter = 0;
    Object.assign(boat, frame.heavyPosition);
    rewriteEngineStopMessage(world, frame.eventStart || 0, boat);
  }

  if (frame.heavyPhase !== "stopping-v165" && heavy.phase !== "stopping-v165") return;
  Object.assign(boat, frame.heavyPosition);
  boat.burstRemaining = 0;
  boat.aimRemaining = 0;
  boat.fireCooldown = 999;
  boat.turretDisabled = true;
  boat.speed += clamp(0 - (Number(boat.speed) || 0), -5.5 * dt, 5.5 * dt);
  const angle = (Number(boat.heading) || 0) * Math.PI / 180;
  boat.x = clamp(boat.x + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp(boat.y - Math.cos(angle) * boat.speed * dt, 84, 306);
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  if (Math.abs(boat.speed) > 0.3) return;

  boat.speed = 0;
  heavy.phase = "repairing";
  heavy.lastDamageAt = Math.min(Number(heavy.lastDamageAt) || -999, (Number(world.time) || 0) - 1.3);
  emit(world, "heavy-repair-start", "Тяжёлый катер полностью остановился. Экипаж начал ставить ремонтные пластины на двигатель.", [0, 1], {
    system: "engine",
    plates: heavy.repairPlates,
    x: boat.x,
    y: boat.y,
  });
}

function finishOverlay(world, dt) {
  const state = ensureState(world);
  restoreDeadSearch(world, state, dt);
  finishEngineStopping(world, state, dt);
  state.frame = null;
  return state;
}

export function prepareCombatAiV165Overlay(world) {
  return prepareOverlay(world);
}

export function finishCombatAiV165Overlay(world, dt) {
  return finishOverlay(world, Math.max(0, Number(dt) || 0));
}

export function applyCombatAiModelV165(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) {
    applyCombatAiModelV164(world, 0, helpers);
    return prepareOverlay(world);
  }
  applyCombatAiModelV164(world, dt, helpers);
  return finishOverlay(world, dt);
}
