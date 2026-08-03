"use strict";

import {applyCombatAiModelV174} from "./free-roam-combat-ai-model-v174.js?v=1";

const REPAIR_START_CLEARANCE = 236;
const REPAIR_ABORT_CLEARANCE = 216;
const ENGINE_CAUTION_RATIO = 0.2;
const EVENT_EPSILON = 0.2;

const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const distance = (a, b) => Math.hypot((Number(a?.x)||0)-(Number(b?.x)||0),(Number(a?.y)||0)-(Number(b?.y)||0));

function ensureState(world) {
  world.freeCombatAiV175 ||= {
    frame: null,
    encounterId: null,
    announcedPhases: {},
    repairCommitted: false,
    lastWindupAt: -Infinity,
    massBombAlertUntil: 0,
  };
  return world.freeCombatAiV175;
}

function livingPlayerPoints(world) {
  return values(world.players).map((player, index) => {
    if (!player?.combat?.alive || world.freeActivities?.presence?.[index] === false) return null;
    if (["boat", "roof"].includes(player.mode)) {
      return values(world.boats).find(boat => String(boat?.id) === String(player.activeBoat)) || player;
    }
    return player;
  }).filter(Boolean);
}

function nearestPlayerDistance(world, point) {
  const players = livingPlayerPoints(world);
  return players.length ? Math.min(...players.map(player => distance(player, point))) : Infinity;
}

function eventAt(event, world) { return Number(event?.at ?? world.time) || 0; }

export function normalizeThreatEventsV175(world, eventStart = 0) {
  const state = ensureState(world);
  const prefix = values(world.events).slice(0, eventStart);
  const fresh = values(world.events).slice(eventStart);
  const result = [];
  const ceasefireKeys = new Set();
  const phaseSeen = new Set();
  let livingHeavyCrew = false;

  for (const actor of values(world.freeHostileActors?.actors)) {
    if (!actor?.active || actor.destroyed || Number(actor.health) <= 0) continue;
    if (String(actor.boatId) === "heavy-pursuer" && actor.state !== "aboard") livingHeavyCrew = true;
  }

  for (const event of fresh) {
    const type = String(event?.type || "");
    const at = eventAt(event, world);

    if (type === "contract-threat-phase" || type === "contract-threat-phase-two" || type === "contract-threat-final-phase") {
      const phase = Number(event.phase || (type.includes("final") ? 3 : type.includes("two") ? 2 : 0));
      const encounter = String(event.encounterId ?? world.freeThreatDirector?.encounterId ?? "active");
      const key = `${encounter}:${phase}`;
      if (phaseSeen.has(key) || state.announcedPhases[key]) continue;
      phaseSeen.add(key);
      state.announcedPhases[key] = at;
      if (phase === 1 && world.freeHeavyPursuer?.boat?.active) {
        event.text = "Первая фаза началась. Повреждённый тяжёлый катер уже находится в районе; подкрепления будут входить поэтапно.";
        event.continuityV175 = true;
      }
    }

    if (["pursuer-ceasefire", "pursuer-destroyed-ceasefire", "combat-ceasefire"].includes(type)) {
      const player = Number(event.targetPlayer ?? event.targets?.[0] ?? -1);
      const bucket = Math.round(at / EVENT_EPSILON);
      const key = `${player}:${bucket}`;
      if (ceasefireKeys.has(key)) continue;
      ceasefireKeys.add(key);
    }

    if ((type === "contract-cleared" || type === "contract-threat-cleared") && livingHeavyCrew) continue;

    if (type === "mega-bomb-heavy-focused-hit" && String(event.targetId || "").startsWith("threat-phase-")) {
      event.text = event.text?.replace(/тяжёлый катер/gi, "вражеский катер") || event.text;
      event.targetKind = "boat";
      event.correctedTargetLabelV175 = true;
    }

    if (type === "heavy-gun-windup") {
      if (at - state.lastWindupAt < 0.75) continue;
      state.lastWindupAt = at;
    }

    result.push(event);
  }
  world.events = [...prefix, ...result];
  return result;
}

export function applyRepairHysteresisV175(world) {
  const state = ensureState(world);
  const boat = world.freeHeavyPursuer?.boat;
  const heavy = world.freeCombatAiV164?.heavy;
  if (!boat?.active || boat.destroyed || !heavy) {
    state.repairCommitted = false;
    return false;
  }
  const repairingTurret = heavy.repairSystem === "turret" && Number(boat.turretHealth) <= 0;
  if (!repairingTurret) {
    state.repairCommitted = false;
    return false;
  }
  const nearest = nearestPlayerDistance(world, boat);
  if (!state.repairCommitted && nearest >= REPAIR_START_CLEARANCE) state.repairCommitted = true;
  if (state.repairCommitted && nearest < REPAIR_ABORT_CLEARANCE) state.repairCommitted = false;

  if (state.repairCommitted) {
    heavy.phase = "breach-repairing-v166";
    boat.speed = 0;
  } else if (heavy.phase === "breach-repairing-v166") {
    heavy.phase = "breach-escaping-v166";
    boat.speed = Math.max(Number(boat.speed)||0, 7.2);
  }
  return state.repairCommitted;
}

export function applyDamagedEngineCautionV175(world) {
  const boat = world.freeHeavyPursuer?.boat;
  const heavy = world.freeCombatAiV164?.heavy;
  if (!boat?.active || boat.destroyed || !heavy || Number(boat.engineHealth) <= 0) return false;
  const ratio = Number(boat.engineHealth) / Math.max(1, Number(boat.maxEngineHealth) || 180);
  if (ratio > ENGINE_CAUTION_RATIO || Number(heavy.repairPlates) <= 0) return false;
  if (Number(boat.turretHealth) <= 0) return false;
  heavy.tacticalMode = "engine-caution-v175";
  heavy.destination ||= world.freeCombatAiV172?.stableRepairDestination || {x: Number(boat.x)||0, y: Number(boat.y)||0};
  if (!["breach-escaping-v166", "breach-repairing-v166"].includes(heavy.phase)) heavy.phase = "retreating";
  boat.speed = Math.max(Number(boat.speed)||0, 6.4);
  return true;
}

export function applyMassBombAdaptationV175(world, eventStart = 0) {
  const state = ensureState(world);
  const fresh = values(world.events).slice(eventStart);
  const casualties = fresh.filter(event => ["enemy-actor-killed", "enemy-boat-destroyed", "pursuer-destroyed"].includes(event?.type)
    && (event.weapon === "mega-bomb" || event.projectileType === "mega-bomb" || String(event.projectileId||"").startsWith("mega-bomb")));
  if (casualties.length >= 3) state.massBombAlertUntil = Math.max(state.massBombAlertUntil, (Number(world.time)||0) + 18);
  if ((Number(world.time)||0) >= state.massBombAlertUntil) return false;

  const actors = values(world.freeHostileActors?.actors).filter(actor => actor?.active && !actor.destroyed && actor.state !== "aboard");
  for (let i = 0; i < actors.length; i += 1) {
    const actor = actors[i];
    actor.formationOffsetX = ((i % 4) - 1.5) * 18;
    actor.formationOffsetY = (Math.floor(i / 4) % 3 - 1) * 16;
    actor.avoidMassExplosives = true;
  }
  for (const boat of values(world.freeThreatDirector?.boats || world.enemyBoats)) {
    if (!boat?.active || boat.destroyed || boat.id === "heavy-pursuer") continue;
    boat.avoidMassExplosives = true;
    boat.minimumAllySpacing = Math.max(Number(boat.minimumAllySpacing)||0, 26);
  }
  return true;
}

export function applyEscortRepairCoverV175(world) {
  const heavyBoat = world.freeHeavyPursuer?.boat;
  const heavy = world.freeCombatAiV164?.heavy;
  if (!heavyBoat?.active || heavyBoat.destroyed || !heavy || !["breach-escaping-v166", "breach-repairing-v166"].includes(heavy.phase)) return false;
  for (const actor of values(world.freeHostileActors?.actors)) {
    if (!actor?.active || actor.destroyed || String(actor.boatId) === "heavy-pursuer") continue;
    actor.tacticalRole = "cover-heavy-repair-v175";
    actor.coverPoint = {x: Number(heavyBoat.x)||0, y: Number(heavyBoat.y)||0};
  }
  for (const boat of values(world.freeThreatDirector?.boats || world.enemyBoats)) {
    if (!boat?.active || boat.destroyed || boat.id === "heavy-pursuer") continue;
    boat.tacticalRole = "screen-heavy-repair-v175";
    boat.screenTargetId = "heavy-pursuer";
  }
  return true;
}

export function prepareCombatAiV175Overlay(world, helpers = {}) {
  const state = ensureState(world);
  state.frame = {eventStart: values(world.events).length};
  applyCombatAiModelV174(world, 0, helpers);
  return state;
}

export function finishCombatAiV175Overlay(world, dt, helpers = {}) {
  const state = ensureState(world);
  applyCombatAiModelV174(world, Math.max(0, Number(dt)||0), helpers);
  const start = state.frame?.eventStart || 0;
  applyRepairHysteresisV175(world);
  applyDamagedEngineCautionV175(world);
  applyMassBombAdaptationV175(world, start);
  applyEscortRepairCoverV175(world);
  normalizeThreatEventsV175(world, start);
  state.frame = null;
  return state;
}

export function applyCombatAiModelV175(world, dt, helpers = {}) {
  return (Number(dt)||0) <= 0 ? prepareCombatAiV175Overlay(world, helpers) : finishCombatAiV175Overlay(world, dt, helpers);
}

export {REPAIR_START_CLEARANCE, REPAIR_ABORT_CLEARANCE, ENGINE_CAUTION_RATIO};
