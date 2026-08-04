"use strict";

import {applyCombatAiHotfixV162} from "./free-roam-combat-ai-hotfix-v162.js?v=1";
import {prepareHeavyAiControllerV1,finishHeavyAiControllerV1} from "./free-roam-heavy-ai-controller-v1.js?v=1";

function ensureState(world) {
  world.freeCombatAiHotfixV163 ||= {encounterId:null,fixedOpeningActorIds:[]};
  const state=world.freeCombatAiHotfixV163;
  if (!Array.isArray(state.fixedOpeningActorIds)) state.fixedOpeningActorIds=state.fixedOpeningActorIds&&typeof state.fixedOpeningActorIds==="object"?Object.values(state.fixedOpeningActorIds):[];
  return state;
}
function openingActor(actor) {
  const id=String(actor?.id||"");
  return id.startsWith("v161-opening-")||id.startsWith("v162-opening-");
}
function preserveOpeningActors(world) {
  const state=ensureState(world),director=world.freeThreatDirector;
  const encounterId=director?.active&&Number(director.level)>=5?Number(director.encounterId)||0:null;
  if (encounterId==null) {state.encounterId=null;state.fixedOpeningActorIds=[];return;}
  if (state.encounterId!==encounterId) {
    state.encounterId=encounterId;
    state.fixedOpeningActorIds=(world.freeHostileActors?.actors||[]).filter(openingActor).map(actor=>String(actor.id));
    return;
  }
  const allowed=new Set(state.fixedOpeningActorIds.map(String));
  if (world.freeHostileActors?.actors) world.freeHostileActors.actors=world.freeHostileActors.actors.filter(actor=>!openingActor(actor)||allowed.has(String(actor.id)));
}
export function applyCombatAiHotfixV163(world,dt,helpers={}) {
  prepareHeavyAiControllerV1(world);
  applyCombatAiHotfixV162(world,dt,helpers);
  preserveOpeningActors(world);
  return finishHeavyAiControllerV1(world,dt);
}
