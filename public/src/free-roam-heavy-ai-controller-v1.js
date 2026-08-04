"use strict";

import {
  clamp,currentHeavyBoat,distance,emit,ensureControllerState,heavyEncounterId,
  incomingMegaBomb,livingPlayers,moveTo,nearestPlayerDistance,pointForPlayer,
  preserveHeavyTargetLocks,publishCompatibility,reconcileHeavyDamage,restorePosition,
  retireStaleHeavyV1,safestPoint,snapshotBoat,cleanHeavyEvents,values,
} from "./free-roam-heavy-ai-support-v1.js?v=1";

export const HEAVY_PHASE_V1=Object.freeze({APPROACH:"approach",COMBAT:"combat",ESCAPE:"escape",STOPPING:"stopping",REPAIRING:"repairing",RETURNING:"returning"});
export const REPAIR_START_CLEARANCE=236;
export const REPAIR_ABORT_CLEARANCE=216;
const OLD_PHASE=new Map([
  ["retreating","escape"],["breach-escaping-v166","escape"],
  ["stopping-v165","stopping"],["breach-stopping-v166","stopping"],
  ["repairing","repairing"],["breach-repairing-v166","repairing"],
  ["returning","returning"],["breach-returning-v166","returning"],
]);

export function normalizeHeavyPhaseV1(heavy) {
  const raw=String(heavy?.phase||"combat");
  heavy.phase=OLD_PHASE.get(raw)||Object.values(HEAVY_PHASE_V1).includes(raw)&&raw||"combat";
  if (heavy.phase==="escape"&&!heavy.escapeReason) heavy.escapeReason=heavy.repairSystem?"repair":"legacy";
  return heavy.phase;
}
function suppress(boat,keepTurret=false) {
  if (!boat||keepTurret) return;
  boat.turretDisabled=true;boat.burstRemaining=0;boat.aimRemaining=0;boat.fireCooldown=Math.max(999,Number(boat.fireCooldown)||0);
}
function initializeHeavy(world,state,boat) {
  const id=heavyEncounterId(world,boat),armourMax=Math.max(1,Number(boat.maxHull)||Number(boat.hull)||700);
  state.encounterId=id;
  state.heavy={encounterId:id,phase:"combat",armourBreached:false,armourMax,coreMax:armourMax>=900?340:260,
    repairPlates:3,repairSystem:null,repairProgress:0,repairQuarter:0,destination:null,
    combatPoint:{x:clamp(boat.x,70,350),y:clamp(boat.y,115,285)},lastDamageAt:-999,
    escapeReason:null,escapeSourcePlayer:null,minimumUntil:-999,maximumUntil:-999};
  const now=Number(world.time)||0;
  const spawned=values(world.events).some(event=>["heavy-pursuer-arrived","heavy-pursuer-approaching"].includes(event?.type)&&Math.abs(now-(Number(event.at)||0))<0.4);
  if (spawned) {
    state.heavy.phase="approach";boat.x=412;boat.y=clamp(state.heavy.combatPoint.y+48,105,300);
    boat.heading=Math.atan2(state.heavy.combatPoint.x-boat.x,-(state.heavy.combatPoint.y-boat.y))*180/Math.PI;boat.speed=0;
    for (const event of values(world.events)) if (event.type==="heavy-pursuer-arrived") {
      event.type="heavy-pursuer-approaching";event.text="Снаружи бухты появился тяжёлый катер. Двигатель слышен всё ближе.";event.x=boat.x;event.y=boat.y;
    }
  }
  publishCompatibility(world,state);
  return state.heavy;
}
function ensureHeavy(world,state) {
  const boat=world.freeHeavyPursuer?.boat;
  if (!boat) {state.heavy=null;state.encounterId=null;publishCompatibility(world,state);return null;}
  const id=heavyEncounterId(world,boat);
  if (!state.heavy||String(state.encounterId)!==String(id)) return initializeHeavy(world,state,boat);
  normalizeHeavyPhaseV1(state.heavy);
  if (!Number.isFinite(state.heavy.repairPlates)) state.heavy.repairPlates=3;
  publishCompatibility(world,state);
  return state.heavy;
}
function preSimulationRules(boat,heavy) {
  const defensive=(heavy.phase==="stopping"||heavy.phase==="repairing")&&heavy.repairSystem==="engine"&&Number(boat.turretHealth)>0;
  if (heavy.phase!=="combat") suppress(boat,defensive);
}
export function prepareHeavyAiControllerV1(world) {
  const state=ensureControllerState(world);
  retireStaleHeavyV1(world,"pre-step");
  const boat=currentHeavyBoat(world),heavy=boat?ensureHeavy(world,state):null;
  state.frame={eventStart:values(world.events).length,directorId:world.freeThreatDirector?.active?String(world.freeThreatDirector.encounterId??""):null,boat:snapshotBoat(boat)};
  if (boat&&heavy) preSimulationRules(boat,heavy);
  return state;
}
function noPlates(world,heavy,boat,system) {
  if (heavy.noPlateSystem===system) return;
  heavy.noPlateSystem=system;
  emit(world,"heavy-repair-no-plates-v1","Система тяжёлого катера уничтожена, но ремонтных пластин больше нет.",[0,1],{system,x:boat.x,y:boat.y});
}
function startRecovery(world,state,boat,heavy,system) {
  if (!system||heavy.repairSystem===system&&["escape","stopping","repairing"].includes(heavy.phase)) return;
  if (Number(heavy.repairPlates)<=0) return noPlates(world,heavy,boat,system);
  heavy.repairSystem=system;heavy.repairProgress=0;heavy.repairQuarter=0;
  if (system==="engine") {heavy.phase="stopping";heavy.destination=null;}
  else {heavy.phase="escape";heavy.escapeReason="repair";heavy.destination=safestPoint(world,boat,state);boat.speed=Math.max(Number(boat.speed)||0,7.2);}
  emit(world,"heavy-system-recovery-v1",system==="engine"
    ?"Двигатель тяжёлого катера уничтожен. Он теряет ход и готовит аварийный ремонт."
    :"Орудийная установка уничтожена. Катер уходит из-под огня и готовит ремонт.",[0,1],{system,plates:heavy.repairPlates,x:boat.x,y:boat.y});
}
function recordAutomaticPressure(world,state,start) {
  const now=Number(world.time)||0;
  state.automaticHits=state.automaticHits.filter(hit=>now-hit.at<=1.05);
  let added=0;
  for (const event of values(world.events).slice(start)) if (event.type==="heavy-component-hit"&&event.weapon==="automatic") {
    state.automaticHits.push({at:Number(event.at)||now,source:Number.isInteger(Number(event.sourcePlayer))?Number(event.sourcePlayer):null});added+=1;
  }
  return added;
}
function startSuppressionEscape(world,state,boat,heavy) {
  if (heavy.phase!=="combat"||Number(boat.engineHealth)<=0) return;
  const latest=[...state.automaticHits].reverse().find(hit=>Number.isInteger(hit.source));
  heavy.phase="escape";heavy.escapeReason="suppression";heavy.escapeSourcePlayer=latest?.source;
  heavy.minimumUntil=(Number(world.time)||0)+4.2;heavy.maximumUntil=(Number(world.time)||0)+8.5;
  heavy.destination=safestPoint(world,boat,state,250);boat.speed=Math.max(Number(boat.speed)||0,11.5);
  emit(world,"heavy-automatic-suppression-escape-v1","Плотная очередь прижала тяжёлый катер. Он даёт полный ход и уходит.",[0,1],{sourcePlayer:latest?.source,x:boat.x,y:boat.y});
}
function chooseTarget(world,boat) {
  return livingPlayers(world).sort((a,b)=>distance(boat,a.point)-distance(boat,b.point))[0]||null;
}
function combatMovement(world,state,boat,heavy,dt,newHits) {
  if (state.automaticHits.length>=3&&newHits>0) return startSuppressionEscape(world,state,boat,heavy);
  const target=chooseTarget(world,boat);
  if (!target) return;
  boat.targetPlayer=target.index;
  const metres=distance(boat,target.point);
  if (metres<210) moveTo(boat,safestPoint(world,boat,state,250),13.4,dt,58);
  else if (metres>276) moveTo(boat,target.point,12.8,dt,48);
  else boat.speed+=clamp(0-boat.speed,-8*dt,8*dt);
}
function advanceHeavy(world,state,boat,heavy,dt,newHits) {
  const phase=normalizeHeavyPhaseV1(heavy),now=Number(world.time)||0;
  if (phase!=="combat") restorePosition(boat,state.frame);
  if (phase==="approach") {
    if (moveTo(boat,heavy.combatPoint,11.8,dt,42)<=4) {
      Object.assign(boat,{x:heavy.combatPoint.x,y:heavy.combatPoint.y,speed:0});heavy.phase="combat";
      emit(world,"heavy-pursuer-arrived","Тяжёлый катер вошёл в бухту и разворачивает установку.",[0,1],{x:boat.x,y:boat.y});
    }
  } else if (phase==="combat") combatMovement(world,state,boat,heavy,dt,newHits);
  else if (phase==="escape") {
    if (Number(boat.engineHealth)<=0) {heavy.phase="stopping";heavy.repairSystem="engine";return;}
    const remaining=moveTo(boat,heavy.destination||(heavy.destination=safestPoint(world,boat,state)),heavy.escapeReason==="suppression"?18.5:14.6,dt,78);
    if (heavy.escapeReason==="suppression") {
      const source=pointForPlayer(world,heavy.escapeSourcePlayer),far=!source||distance(boat,source)>=250;
      if (now>=heavy.minimumUntil&&(far||now>=heavy.maximumUntil)) {heavy.phase="returning";heavy.destination=heavy.combatPoint;heavy.escapeReason=null;}
    } else if (remaining<=6&&nearestPlayerDistance(world,boat)>=REPAIR_START_CLEARANCE&&!incomingMegaBomb(world,boat)) {
      boat.speed=0;heavy.phase="repairing";heavy.repairProgress=0;
      emit(world,"heavy-repair-start-v1",`Начат ремонт: ${heavy.repairSystem==="engine"?"двигатель":"оружейная установка"}.`,[0,1],{system:heavy.repairSystem,plates:heavy.repairPlates,x:boat.x,y:boat.y});
    } else if (remaining<=8) heavy.destination=safestPoint(world,boat,state);
  } else if (phase==="stopping") {
    boat.speed+=clamp(0-boat.speed,-5.8*dt,5.8*dt);const radians=boat.heading*Math.PI/180;
    boat.x=clamp(boat.x+Math.sin(radians)*boat.speed*dt,14,406);boat.y=clamp(boat.y-Math.cos(radians)*boat.speed*dt,84,310);
    if (Math.abs(boat.speed)<=0.3) {
      boat.speed=0;heavy.phase="repairing";heavy.repairProgress=0;
      emit(world,"heavy-repair-start-v1","Катер остановился. Начат аварийный ремонт двигателя.",[0,1],{system:"engine",plates:heavy.repairPlates,x:boat.x,y:boat.y});
    }
  } else if (phase==="repairing") {
    boat.speed=0;
    if (heavy.repairSystem==="turret"&&(nearestPlayerDistance(world,boat)<REPAIR_ABORT_CLEARANCE||incomingMegaBomb(world,boat))) {
      heavy.phase="escape";heavy.escapeReason="repair";heavy.repairProgress*=0.35;heavy.destination=safestPoint(world,boat,state);boat.speed=7.2;
      emit(world,"heavy-repair-aborted-v1","Ты подошёл слишком близко или запустил мега-бомбу. Катер сорвал ремонт и снова уходит.",[0,1],{x:boat.x,y:boat.y});return;
    }
    if (now-(Number(heavy.lastDamageAt)||-999)>=1.2) heavy.repairProgress+=dt;
    else heavy.repairProgress=Math.max(0,heavy.repairProgress-dt*1.5);
    const duration=heavy.repairSystem==="engine"?9:12,quarter=Math.min(4,Math.floor(heavy.repairProgress/duration*4));
    if (quarter>heavy.repairQuarter&&quarter<4) {
      heavy.repairQuarter=quarter;emit(world,"heavy-repair-progress-v1",`Ремонт: ${quarter*25} процентов.`,[0,1],{system:heavy.repairSystem,percent:quarter*25,x:boat.x,y:boat.y});
    }
    if (heavy.repairProgress>=duration) {
      const system=heavy.repairSystem;
      if (system==="engine") {boat.engineHealth=Math.max(1,(boat.maxEngineHealth||180)*0.68);boat.engineDisabled=false;}
      else {boat.turretHealth=Math.max(1,(boat.maxTurretHealth||240)*0.68);boat.turretDisabled=false;}
      heavy.repairPlates=Math.max(0,Number(heavy.repairPlates)-1);heavy.repairSystem=null;heavy.repairProgress=0;heavy.repairQuarter=0;heavy.phase="returning";heavy.destination=heavy.combatPoint;
      emit(world,"heavy-repair-complete-v1",`Ремонт завершён. Осталось пластин: ${heavy.repairPlates}.`,[0,1],{system,plates:heavy.repairPlates,x:boat.x,y:boat.y});
    }
  } else if (phase==="returning") {
    if (Number(boat.engineHealth)<=0) {heavy.phase="stopping";heavy.repairSystem="engine";return;}
    if (moveTo(boat,heavy.destination||heavy.combatPoint,12.1,dt,62)<=8) {
      boat.speed=0;heavy.phase="combat";heavy.destination=null;
      emit(world,"heavy-repair-returned-v1","Тяжёлый катер вернулся в бой.",[0,1],{x:boat.x,y:boat.y});
    }
  }
  const defensive=(heavy.phase==="stopping"||heavy.phase==="repairing")&&heavy.repairSystem==="engine"&&Number(boat.turretHealth)>0;
  if (heavy.phase!=="combat") suppress(boat,defensive);
}
export function finishHeavyAiControllerV1(world,dt) {
  const state=ensureControllerState(world),frame=state.frame||{eventStart:values(world.events).length,boat:snapshotBoat(currentHeavyBoat(world))};
  const directorId=world.freeThreatDirector?.active?String(world.freeThreatDirector.encounterId??""):null;
  if (frame.directorId!==undefined&&frame.directorId!==directorId&&frame.boat?.ref===world.freeHeavyPursuer?.boat) retireStaleHeavyV1(world,"encounter-changed",true);
  const boat=currentHeavyBoat(world),heavy=boat?ensureHeavy(world,state):null;
  if (boat&&heavy) {
    reconcileHeavyDamage(world,state,boat,heavy,frame);
    if (Number(boat.hull)>0) {
      if (boat.engineDisabled) startRecovery(world,state,boat,heavy,"engine");
      else if (boat.turretDisabled) startRecovery(world,state,boat,heavy,"turret");
      const newHits=recordAutomaticPressure(world,state,frame.eventStart);
      advanceHeavy(world,state,boat,heavy,Math.max(0,Number(dt)||0),newHits);
    }
  }
  preserveHeavyTargetLocks(world,state,frame.eventStart);
  cleanHeavyEvents(world,state,frame.eventStart);
  state.frame=null;publishCompatibility(world,state);return state;
}
export function applyHeavyAiControllerV1(world,dt,runBase=null) {
  prepareHeavyAiControllerV1(world);
  if (typeof runBase==="function") runBase();
  return finishHeavyAiControllerV1(world,dt);
}
