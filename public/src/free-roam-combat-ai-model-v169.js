"use strict";

import {applyCombatAiModelV168} from "./free-roam-combat-ai-model-v168.js?v=2";

const ENGINE_DEFENCE_PHASES = new Set([
  "breach-stopping-v166",
  "breach-repairing-v166",
]);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureState(world) {
  world.freeCombatAiV169 ||= {frame: null};
  return world.freeCombatAiV169;
}

function weaponSnapshot(boat) {
  if (!boat) return null;
  return {
    fireCooldown: Number(boat.fireCooldown) || 0,
    burstRemaining: Math.max(0, Number(boat.burstRemaining) || 0),
    burstCooldown: Math.max(0, Number(boat.burstCooldown) || 0),
    aimRemaining: Math.max(0, Number(boat.aimRemaining) || 0),
    turretHeading: Number(boat.turretHeading) || Number(boat.heading) || 0,
  };
}

function defensiveFireAllowed(heavy, boat) {
  return Boolean(
    heavy
    && boat
    && boat.active
    && !boat.destroyed
    && Number(boat.hull) > 0
    && ENGINE_DEFENCE_PHASES.has(heavy.phase)
    && heavy.repairSystem === "engine"
    && Number(boat.engineHealth) <= 0
    && Number(boat.turretHealth) > 0
  );
}

function normalizedWeapon(snapshot) {
  const next = snapshot || {};
  const cooldown = Number(next.fireCooldown) || 0;
  return {
    fireCooldown: cooldown > 30 ? 0.85 : Math.max(0, cooldown),
    burstRemaining: Math.max(0, Number(next.burstRemaining) || 0),
    burstCooldown: Math.max(0, Number(next.burstCooldown) || 0),
    aimRemaining: Math.max(0, Number(next.aimRemaining) || 0),
    turretHeading: Number(next.turretHeading) || 0,
  };
}

export function restoreEngineDefensiveFireV169(world, snapshot) {
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  if (!defensiveFireAllowed(heavy, boat)) {
    if (heavy) heavy.v169DefensiveFireActive = false;
    return false;
  }

  const weapon = normalizedWeapon(snapshot);
  boat.turretDisabled = false;
  heavy.actualTurretDisabled = false;
  boat.fireCooldown = weapon.fireCooldown;
  boat.burstRemaining = weapon.burstRemaining;
  boat.burstCooldown = weapon.burstCooldown;
  boat.aimRemaining = weapon.aimRemaining;
  boat.turretHeading = weapon.turretHeading || boat.turretHeading || boat.heading;
  heavy.v169DefensiveFireActive = true;
  return true;
}

function removeSupersededEngineMessage(world, eventStart) {
  const start = Math.max(0, Number(eventStart) || 0);
  const prefix = (world.events || []).slice(0, start);
  const filtered = (world.events || []).slice(start).filter(event => !(
    event?.type === "heavy-tactical-mode-v168"
    && event.mode === "engine-trapped-repair"
  ));
  world.events = [...prefix, ...filtered];
}

export function prepareCombatAiV169Overlay(world, helpers = {}) {
  const state = ensureState(world);
  const boat = world.freeHeavyPursuer?.boat;
  state.frame = {
    eventStart: world.events?.length || 0,
    weaponBeforePrepare: weaponSnapshot(boat),
  };

  applyCombatAiModelV168(world, 0, helpers);
  restoreEngineDefensiveFireV169(world, state.frame.weaponBeforePrepare);
  return state;
}

export function finishCombatAiV169Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  const postSimulationWeapon = weaponSnapshot(world.freeHeavyPursuer?.boat);
  applyCombatAiModelV168(world, Math.max(0, Number(dt) || 0), helpers);

  const restored = restoreEngineDefensiveFireV169(world, postSimulationWeapon);
  if (restored) {
    removeSupersededEngineMessage(world, state.frame?.eventStart);
    const heavy = world.freeCombatAiV164?.heavy;
    if (!heavy.v169DefensiveFireAnnounced) {
      heavy.v169DefensiveFireAnnounced = true;
      const boat = world.freeHeavyPursuer.boat;
      emit(world, "heavy-engine-defensive-fire-v169",
        "Двигатель тяжёлого катера уничтожен. Он остановился и чинится, но исправная установка продолжает отстреливаться. Добивай корпус, меняя позицию.",
        [0, 1], {
          x: boat.x,
          y: boat.y,
          targetPlayer: boat.targetPlayer,
        });
    }
  } else if (world.freeCombatAiV164?.heavy) {
    world.freeCombatAiV164.heavy.v169DefensiveFireAnnounced = false;
  }

  state.frame = null;
  return state;
}

export function applyCombatAiModelV169(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) return prepareCombatAiV169Overlay(world, helpers);
  return finishCombatAiV169Overlay(world, dt, helpers);
}
