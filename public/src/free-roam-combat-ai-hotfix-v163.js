"use strict";

import {applyCombatAiHotfixV162} from "./free-roam-combat-ai-hotfix-v162.js?v=1";

function ensureState(world) {
  world.freeCombatAiHotfixV163 ||= {
    encounterId: null,
    fixedOpeningActorIds: [],
  };
  const state = world.freeCombatAiHotfixV163;
  state.fixedOpeningActorIds ||= [];
  return state;
}

function openingActor(actor) {
  const id = String(actor?.id || "");
  return id.startsWith("v161-opening-") || id.startsWith("v162-opening-");
}

function freezeOpeningGroup(world, state, encounterId) {
  state.encounterId = encounterId;
  state.fixedOpeningActorIds = (world.freeHostileActors?.actors || [])
    .filter(openingActor)
    .map(actor => String(actor.id));
}

function removeReplacementActors(world, state) {
  const hostile = world.freeHostileActors;
  if (!hostile?.actors?.length) return;
  const allowed = new Set(state.fixedOpeningActorIds.map(String));
  hostile.actors = hostile.actors.filter(actor => !openingActor(actor) || allowed.has(String(actor.id)));
}

export function applyCombatAiHotfixV163(world, dt, helpers = {}) {
  const state = ensureState(world);
  const director = world.freeThreatDirector;
  const encounterId = director?.active && Number(director.level) >= 5
    ? Number(director.encounterId) || 0
    : null;

  applyCombatAiHotfixV162(world, dt, helpers);

  if (encounterId == null) {
    state.encounterId = null;
    state.fixedOpeningActorIds = [];
    return;
  }
  if (state.encounterId !== encounterId) {
    freezeOpeningGroup(world, state, encounterId);
    return;
  }
  removeReplacementActors(world, state);
}
