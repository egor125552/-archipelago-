"use strict";

import {addEliteActor,ensureHostileActors} from "./free-roam-hostile-actors.js?v=2";
import {
  clamp,currentHeavyBoat,distance,emit,ensureControllerState,heavyEncounterId,
  incomingMegaBomb,livingPlayers,moveTo,nearestPlayerDistance,pointForPlayer,
  preserveHeavyTargetLocks,publishCompatibility,reconcileHeavyDamage,restorePosition,
  retireStaleHeavyV1,safestPoint,snapshotBoat,cleanHeavyEvents,values,
} from "./free-roam-heavy-ai-support-v1.js?v=1";

export const HEAVY_PHASE_V1=Object.freeze({APPROACH:"approach",COMBAT:"combat",ESCAPE:"escape",STOPPING:"stopping",REPAIRING:"repairing",RETURNING:"returning"});
export const REPAIR_START_CLEARANCE=236;
export const REPAIR_ABORT_CLEARANCE=216;
export const REPAIR_ARRIVAL_RADIUS=6;
export const REPAIR_ROUTE_MARGIN=8;
export const HULL_DAMAGE_WINDOW=3.6;
export const HULL_ESCAPE_CLEARANCE=250;
export const HULL_ESCAPE_ARMOUR_RATIO=0.34;
export const HULL_ESCAPE_CORE_LIMIT=220;
export const HULL_STANDOFF_MIN=226;
export const HULL_STANDOFF_MAX=242;
export const HULL_STANDOFF_TARGET=234;
export const HULL_STANDOFF_QUIET=4.5;
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
function suspendTurret(boat) {
  if (!boat) return;
  if (!Number.isFinite(Number(boat.resumeFireCooldownV1))) {
    const current=Math.max(0,Number(boat.fireCooldown)||0);
    boat.resumeFireCooldownV1=current>30?0.35:Math.min(2.2,current);
  }
  boat.burstRemaining=0;boat.aimRemaining=0;boat.fireCooldown=0.35;
}
function resumeTurret(boat) {
  if (!boat) return;
  const stored=Number(boat.resumeFireCooldownV1);
  if (Number.isFinite(stored)) {
    boat.fireCooldown=clamp(stored,0.2,2.2);
    delete boat.resumeFireCooldownV1;
  } else if ((Number(boat.fireCooldown)||0)>30) boat.fireCooldown=0.35;
}
function turretCanCover(boat,heavy) {
  if (!boat||Number(boat.turretHealth)<=0||boat.turretDisabled) return false;
  if (heavy.phase==="escape"&&["suppression","hull-danger"].includes(heavy.escapeReason)) return true;
  return ["stopping","repairing"].includes(heavy.phase)&&heavy.repairSystem==="engine";
}
function initializeHeavy(world,state,boat) {
  const id=heavyEncounterId(world,boat),armourMax=Math.max(1,Number(boat.maxHull)||Number(boat.hull)||700);
  state.encounterId=id;
  state.hullDamageSamples=[];
  state.heavy={encounterId:id,phase:"combat",armourBreached:false,armourMax,coreMax:armourMax>=900?340:260,
    repairPlates:3,repairSystem:null,repairProgress:0,repairQuarter:0,destination:null,
    repairRouteClearance:null,repairEscapeStartedAt:-999,repairReroutes:0,
    combatPoint:{x:clamp(boat.x,70,350),y:clamp(boat.y,115,285)},lastDamageAt:-999,
    escapeReason:null,escapeSourcePlayer:null,minimumUntil:-999,maximumUntil:-999,
    hullEscapeStartedAt:-999,hullEscapeThreshold:null,hullEscapeDps:0,hullEscapeRerouteAt:-999,
    hullEscapeMode:"flee",hullStandoffAt:-999,hullStandoffAnnouncedAt:-999,
    hullDangerDuringRepair:false};
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
  if (!Number.isFinite(state.heavy.repairEscapeStartedAt)) state.heavy.repairEscapeStartedAt=-999;
  if (!Number.isFinite(state.heavy.repairReroutes)) state.heavy.repairReroutes=0;
  if (!Number.isFinite(state.heavy.hullEscapeStartedAt)) state.heavy.hullEscapeStartedAt=-999;
  if (!Number.isFinite(state.heavy.hullEscapeDps)) state.heavy.hullEscapeDps=0;
  if (!Number.isFinite(state.heavy.hullEscapeRerouteAt)) state.heavy.hullEscapeRerouteAt=-999;
  if (!["flee","standoff"].includes(state.heavy.hullEscapeMode)) state.heavy.hullEscapeMode="flee";
  if (!Number.isFinite(state.heavy.hullStandoffAt)) state.heavy.hullStandoffAt=-999;
  if (!Number.isFinite(state.heavy.hullStandoffAnnouncedAt)) state.heavy.hullStandoffAnnouncedAt=-999;
  if (typeof state.heavy.hullDangerDuringRepair!=="boolean") state.heavy.hullDangerDuringRepair=false;
  publishCompatibility(world,state);
  return state.heavy;
}
function adoptDueHeavy(world,state,boat,heavy) {
  const director=world.freeThreatDirector;
  if (!director?.active||Number(director.level)<5||director.heavyStarted) return false;
  if ((Number(world.time)||0)+0.06<(Number(director.heavyStartsAt)||Infinity)) return false;
  const id=Number(director.encounterId)||state.encounterId||world.freeHeavyPursuer?.encounterId;
  const target=livingPlayers(world)[0]?.index??(Number(boat.targetPlayer)||0);
  director.heavyStarted=true;director.heavyStartsAt=0;director.assignments||={};director.assignments[boat.id]=target;
  world.freeHeavyPursuer.encounterId=id;state.encounterId=id;heavy.encounterId=id;boat.targetPlayer=target;
  const hostile=ensureHostileActors(world),eliteId=`elite-${id}`;
  if (!values(hostile.actors).some(actor=>actor?.active&&!actor.destroyed&&String(actor.id)===eliteId)) addEliteActor(world,boat,target,id);
  if (String(state.adoptedEncounterId)!==String(id)) {
    state.adoptedEncounterId=id;
    emit(world,"contract-threat-phase","Вторая фаза. Повреждённый тяжёлый катер продолжает бой без восстановления.",[0,1],{phase:2,encounterId:id,continuityV1:true,x:boat.x,y:boat.y});
  }
  publishCompatibility(world,state);
  return true;
}
function restoreDuplicateHeavy(world,state,frame) {
  const current=world.freeHeavyPursuer?.boat,old=frame?.boat;
  if (!old?.ref||!current||current===old.ref) return false;
  const fresh=values(world.events).slice(frame.eventStart);
  if (!fresh.some(event=>["heavy-pursuer-arrived","heavy-pursuer-approaching"].includes(event.type))) return false;
  Object.assign(old.ref,old.data);
  world.freeHeavyPursuer.boat=old.ref;world.freeHeavyPursuer.active=true;
  world.freeHeavyPursuer.projectiles=(frame.projectiles||[]).map(item=>({...item}));
  world.freeHeavyPursuer.nextProjectileId=frame.nextProjectileId;
  world.events=values(world.events).filter((event,index)=>index<frame.eventStart||!["heavy-pursuer-arrived","heavy-pursuer-approaching"].includes(event.type));
  emit(world,"heavy-pursuer-continuity-restored-v1","Тяжёлый катер сохранил повреждения, координаты и текущий манёвр.",[0,1],{phase:state.heavy?.phase,hull:old.ref.hull,x:old.ref.x,y:old.ref.y});
  return true;
}
function preSimulationRules(boat,heavy) {
  if (heavy.phase==="combat"||turretCanCover(boat,heavy)) resumeTurret(boat);
  else suspendTurret(boat);
}
export function prepareHeavyAiControllerV1(world) {
  const state=ensureControllerState(world);
  retireStaleHeavyV1(world,"pre-step");
  const boat=currentHeavyBoat(world),heavy=boat?ensureHeavy(world,state):null;
  if (boat&&heavy) adoptDueHeavy(world,state,boat,heavy);
  state.frame={eventStart:values(world.events).length,directorId:world.freeThreatDirector?.active?String(world.freeThreatDirector.encounterId??""):null,boat:snapshotBoat(boat),projectiles:values(world.freeHeavyPursuer?.projectiles).map(item=>({...item})),nextProjectileId:world.freeHeavyPursuer?.nextProjectileId};
  if (boat&&heavy) preSimulationRules(boat,heavy);
  return state;
}
function noPlates(world,heavy,boat,system) {
  if (heavy.noPlateSystem===system) return;
  heavy.noPlateSystem=system;
  emit(world,"heavy-repair-no-plates-v1","Система тяжёлого катера уничтожена, но ремонтных пластин больше нет.",[0,1],{system,x:boat.x,y:boat.y});
}
function assignRepairRoute(world,state,boat,heavy,resetClock=false) {
  const destination=safestPoint(world,boat,state);
  heavy.destination=destination;
  heavy.repairRouteClearance=nearestPlayerDistance(world,destination);
  heavy.repairReroutes=resetClock?0:(Number(heavy.repairReroutes)||0)+1;
  if (resetClock||!Number.isFinite(heavy.repairEscapeStartedAt)||heavy.repairEscapeStartedAt<0) heavy.repairEscapeStartedAt=Number(world.time)||0;
  return destination;
}
export function requiredRepairClearanceV1(heavy) {
  const planned=Number(heavy?.repairRouteClearance);
  if (!Number.isFinite(planned)) return REPAIR_START_CLEARANCE;
  return clamp(planned-REPAIR_ROUTE_MARGIN,REPAIR_ABORT_CLEARANCE+4,REPAIR_START_CLEARANCE);
}
export function moveHeavyToRepairPointV1(boat,destination,maxSpeed,dt,turnRate=78,arrivalRadius=REPAIR_ARRIVAL_RADIUS) {
  if (!destination) return Infinity;
  const before=distance(boat,destination);
  const reach=Math.max(arrivalRadius,Math.abs(Number(boat.speed)||0)*Math.max(0,dt)+0.75);
  if (before<=reach) {
    boat.x=destination.x;boat.y=destination.y;boat.speed=0;return 0;
  }
  const brakingSpeed=Math.sqrt(Math.max(0,2*7.5*Math.max(0,before-arrivalRadius)));
  const wantedSpeed=Math.min(maxSpeed,Math.max(1.8,brakingSpeed));
  const after=moveTo(boat,destination,wantedSpeed,dt,turnRate);
  if (after<=arrivalRadius) {
    boat.x=destination.x;boat.y=destination.y;boat.speed=0;return 0;
  }
  if (after>before&&before<=Math.max(18,Math.abs(Number(boat.speed)||0)*1.25)) {
    boat.x=destination.x;boat.y=destination.y;boat.speed=0;return 0;
  }
  return after;
}
function beginStoppingForRepair(world,boat,heavy) {
  heavy.phase="stopping";heavy.repairProgress=0;heavy.repairQuarter=0;
  emit(world,"heavy-repair-stopping-v1",`Тяжёлый катер достиг точки отхода и останавливается перед ремонтом ${heavy.repairSystem==="engine"?"двигателя":"оружейной установки"}.`,[0,1],{
    system:heavy.repairSystem,plates:heavy.repairPlates,x:boat.x,y:boat.y,
  });
}
function startRecovery(world,state,boat,heavy,system) {
  if (!system||heavy.repairSystem===system&&["escape","stopping","repairing"].includes(heavy.phase)) return;
  if (Number(heavy.repairPlates)<=0) return noPlates(world,heavy,boat,system);
  heavy.repairSystem=system;heavy.repairProgress=0;heavy.repairQuarter=0;
  if (system==="engine") {
    heavy.phase="stopping";heavy.destination=null;heavy.repairRouteClearance=null;heavy.repairEscapeStartedAt=Number(world.time)||0;heavy.repairReroutes=0;
  } else {
    heavy.phase="escape";heavy.escapeReason="repair";assignRepairRoute(world,state,boat,heavy,true);boat.speed=Math.max(Number(boat.speed)||0,7.2);
  }
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
export function emergencyEscapeSpeedV1(boat) {
  const maximum=Math.max(1,Number(boat?.maxEngineHealth)||180);
  const health=clamp((Number(boat?.engineHealth)||0)/maximum,0,1);
  return 11.5+8*health;
}
function hullDamageEvent(event) {
  return (event?.type==="heavy-component-hit"&&event.component==="hull")
    ||(event?.type==="mega-bomb-heavy-focused-hit"&&String(event.component||"").includes("корпус"));
}
export function evaluateHullDangerV1(world,state,boat,heavy,frame) {
  const now=Number(world.time)||0,start=Number(frame?.eventStart)||0,fresh=values(world.events).slice(start);
  if (!Array.isArray(state.hullDamageSamples)) state.hullDamageSamples=[];
  state.hullDamageSamples=state.hullDamageSamples.filter(sample=>now-(Number(sample.at)||0)<=HULL_DAMAGE_WINDOW);
  const breachedNow=fresh.some(event=>event.type==="heavy-armour-breached");
  const before=Number(frame?.boat?.hull),after=Number(boat?.hull);
  let damage=Number.isFinite(before)&&Number.isFinite(after)?Math.max(0,before-after):0;
  if (breachedNow) damage=Math.max(damage,Math.max(70,(Number(heavy?.armourMax)||700)*0.18));
  const latest=[...fresh].reverse().find(hullDamageEvent)
    ||[...fresh].reverse().find(event=>event?.type==="heavy-armour-breached")
    ||null;
  if (damage>0) state.hullDamageSamples.push({
    at:now,amount:damage,
    source:Number.isInteger(Number(latest?.sourcePlayer))?Number(latest.sourcePlayer):null,
    weapon:latest?.weapon||latest?.type||null,
  });
  const total=state.hullDamageSamples.reduce((sum,sample)=>sum+Math.max(0,Number(sample.amount)||0),0);
  const oldest=state.hullDamageSamples[0]?.at??now;
  const observed=Math.max(1.25,now-(Number(oldest)||now)+0.08);
  const dps=total/observed;
  const maxHull=Math.max(1,heavy?.armourBreached?Number(heavy.coreMax)||Number(boat.maxHull)||260:Number(heavy?.armourMax)||Number(boat.maxHull)||700);
  const hull=Math.max(0,Number(boat?.hull)||0);
  const nearest=nearestPlayerDistance(world,boat);
  const travel=Math.max(30,HULL_ESCAPE_CLEARANCE-(Number.isFinite(nearest)?nearest:0));
  const escapeSeconds=1.25+travel/Math.max(1,emergencyEscapeSpeedV1(boat));
  const reserve=Math.max(48,maxHull*0.08);
  const predictedLoss=dps*escapeSeconds;
  const staticLimit=heavy?.armourBreached?Math.min(HULL_ESCAPE_CORE_LIMIT,maxHull*0.84):Math.max(230,maxHull*HULL_ESCAPE_ARMOUR_RATIO);
  const bombShock=damage>=Math.max(18,maxHull*0.045)&&String(latest?.weapon||latest?.type||"").includes("mega-bomb");
  const bombDangerLimit=heavy?.armourBreached?Math.max(staticLimit,maxHull*0.94):Math.max(staticLimit,maxHull*0.8);
  const sustained=state.hullDamageSamples.length>=2&&hull<=predictedLoss+reserve;
  const shouldEscape=breachedNow||hull<=staticLimit||sustained||(bombShock&&hull<=bombDangerLimit);
  return {shouldEscape,breachedNow,damage,dps,hull,maxHull,staticLimit,predictedLoss,reserve,escapeSeconds,source:state.hullDamageSamples.at(-1)?.source??null,bombShock,bombDangerLimit};
}
function pointSegmentDistance(point,a,b) {
  const dx=(Number(b?.x)||0)-(Number(a?.x)||0),dy=(Number(b?.y)||0)-(Number(a?.y)||0);
  const length=dx*dx+dy*dy;
  if (length<=0) return distance(point,a);
  const amount=clamp((((Number(point?.x)||0)-(Number(a?.x)||0))*dx+((Number(point?.y)||0)-(Number(a?.y)||0))*dy)/length,0,1);
  return Math.hypot((Number(point?.x)||0)-((Number(a?.x)||0)+dx*amount),(Number(point?.y)||0)-((Number(a?.y)||0)+dy*amount));
}
function survivalPoint(world,boat,state) {
  const people=livingPlayers(world);
  if (!people.length) return safestPoint(world,boat,state,HULL_ESCAPE_CLEARANCE);
  const current=nearestPlayerDistance(world,boat),nearest=[...people].sort((a,b)=>distance(boat,a.point)-distance(boat,b.point))[0];
  const awayX=(Number(boat.x)||0)-(Number(nearest.point.x)||0),awayY=(Number(boat.y)||0)-(Number(nearest.point.y)||0);
  const awayLength=Math.max(1,Math.hypot(awayX,awayY));
  const points=[];
  for (const x of [16,42,88,150,210,272,334,380,404]) for (const y of [86,108,150,200,250,292,308]) points.push({x,y});
  const scored=points.map(point=>{
    const travel=distance(boat,point);
    const endpoint=Math.min(...people.map(person=>distance(point,person.point)));
    const path=Math.min(...people.map(person=>pointSegmentDistance(person.point,boat,point)));
    const vx=point.x-(Number(boat.x)||0),vy=point.y-(Number(boat.y)||0),length=Math.max(1,Math.hypot(vx,vy));
    const away=(vx*awayX+vy*awayY)/(length*awayLength);
    return {point,travel,endpoint,path,away};
  }).filter(item=>item.travel>=35);
  return scored.sort((a,b)=>(b.path>=current-3)-(a.path>=current-3)||b.path-a.path||b.endpoint-a.endpoint||b.away-a.away||b.travel-a.travel)[0]?.point
    ||safestPoint(world,boat,state,HULL_ESCAPE_CLEARANCE);
}
function hullStandoffPoint(world,boat,state,target) {
  if (!target?.point) return survivalPoint(world,boat,state);
  const current=distance(boat,target.point);
  const base=Math.atan2((Number(boat.y)||0)-(Number(target.point.y)||0),(Number(boat.x)||0)-(Number(target.point.x)||0));
  const offsets=[0,Math.PI/10,-Math.PI/10,Math.PI/5,-Math.PI/5,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2,Math.PI];
  const candidates=offsets.map(offset=>{
    const angle=base+offset;
    const point={
      x:clamp((Number(target.point.x)||0)+Math.cos(angle)*HULL_STANDOFF_TARGET,16,404),
      y:clamp((Number(target.point.y)||0)+Math.sin(angle)*HULL_STANDOFF_TARGET,86,308),
    };
    const actual=distance(point,target.point),travel=distance(boat,point);
    const path=pointSegmentDistance(target.point,boat,point);
    const bandPenalty=actual<HULL_STANDOFF_MIN?(HULL_STANDOFF_MIN-actual)*80
      :actual>HULL_STANDOFF_MAX?(actual-HULL_STANDOFF_MAX)*80:0;
    const crossingPenalty=path<Math.min(Math.max(0,current-3),HULL_STANDOFF_MIN-8)?600:0;
    return {point,score:bandPenalty+crossingPenalty+Math.abs(actual-HULL_STANDOFF_TARGET)*3+travel*0.08};
  });
  return candidates.sort((a,b)=>a.score-b.score)[0]?.point||survivalPoint(world,boat,state);
}
function resumeHullFlight(world,state,boat,heavy) {
  const now=Number(world.time)||0;
  heavy.hullEscapeMode="flee";heavy.hullStandoffAt=-999;
  heavy.destination=survivalPoint(world,boat,state);heavy.hullEscapeRerouteAt=now;
  boat.speed=Math.max(Number(boat.speed)||0,emergencyEscapeSpeedV1(boat)*0.78);
  return heavy.destination;
}
function enterHullStandoff(world,state,boat,heavy,target) {
  const now=Number(world.time)||0;
  heavy.hullEscapeMode="standoff";heavy.hullStandoffAt=now;
  heavy.destination=hullStandoffPoint(world,boat,state,target);
  boat.speed=Math.min(Number(boat.speed)||0,13.2);
  if (now-(Number(heavy.hullStandoffAnnouncedAt)||-999)>=12) {
    heavy.hullStandoffAnnouncedAt=now;
    emit(world,"heavy-hull-standoff-v1","Тяжёлый катер занял дальнюю огневую позицию и снова ведёт огонь.",[0,1],{
      targetPlayer:target?.index??null,distance:target?.point?distance(boat,target.point):null,x:boat.x,y:boat.y,
    });
  }
  return heavy.destination;
}
function startSuppressionEscape(world,state,boat,heavy) {
  if (heavy.phase!=="combat"||Number(boat.engineHealth)<=0) return;
  const latest=[...state.automaticHits].reverse().find(hit=>Number.isInteger(hit.source));
  heavy.phase="escape";heavy.escapeReason="suppression";heavy.escapeSourcePlayer=latest?.source;
  heavy.minimumUntil=(Number(world.time)||0)+4.2;heavy.maximumUntil=(Number(world.time)||0)+8.5;
  heavy.destination=survivalPoint(world,boat,state);boat.speed=Math.max(Number(boat.speed)||0,11.5);
  emit(world,"heavy-automatic-suppression-escape-v1","Плотная очередь прижала тяжёлый катер. Он даёт полный ход и уходит.",[0,1],{sourcePlayer:latest?.source,x:boat.x,y:boat.y});
}
function startHullDangerEscape(world,state,boat,heavy,danger) {
  if (Number(boat.engineHealth)<=0||heavy.repairSystem) return false;
  const now=Number(world.time)||0,already=heavy.phase==="escape"&&heavy.escapeReason==="hull-danger";
  heavy.phase="escape";heavy.escapeReason="hull-danger";heavy.escapeSourcePlayer=danger.source;heavy.maximumUntil=Infinity;
  if (!already) {
    heavy.minimumUntil=now+6;heavy.hullEscapeStartedAt=now;heavy.hullEscapeMode="flee";heavy.hullStandoffAt=-999;
    heavy.destination=survivalPoint(world,boat,state);
  } else if (danger.damage>0||danger.breachedNow||danger.bombShock) resumeHullFlight(world,state,boat,heavy);
  else if (!heavy.destination&&heavy.hullEscapeMode!=="standoff") heavy.destination=survivalPoint(world,boat,state);
  heavy.hullEscapeThreshold=danger.staticLimit;heavy.hullEscapeDps=danger.dps;
  if (heavy.hullEscapeMode!=="standoff") boat.speed=Math.max(Number(boat.speed)||0,emergencyEscapeSpeedV1(boat)*0.78);
  if (!already) emit(world,"heavy-hull-danger-escape-v1","Корпус тяжёлого катера не выдержит продолжение боя. Он стреляет на отходе и уходит на максимальной скорости.",[0,1],{
    sourcePlayer:danger.source,hull:danger.hull,maxHull:danger.maxHull,damageRate:danger.dps,predictedLoss:danger.predictedLoss,x:boat.x,y:boat.y,
  });
  return true;
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
    if (moveHeavyToRepairPointV1(boat,heavy.combatPoint,11.8,dt,42,4)<=0) {
      Object.assign(boat,{x:heavy.combatPoint.x,y:heavy.combatPoint.y,speed:0});heavy.phase="combat";
      emit(world,"heavy-pursuer-arrived","Тяжёлый катер вошёл в бухту и разворачивает установку.",[0,1],{x:boat.x,y:boat.y});
    }
  } else if (phase==="combat") combatMovement(world,state,boat,heavy,dt,newHits);
  else if (phase==="escape") {
    if (Number(boat.engineHealth)<=0) {heavy.phase="stopping";heavy.repairSystem="engine";return;}
    const repairEscape=heavy.escapeReason==="repair";
    const hullEscape=heavy.escapeReason==="hull-danger";
    let destination=null,remaining=Infinity;
    if (repairEscape) {
      destination=heavy.destination||assignRepairRoute(world,state,boat,heavy,true);
      const repairSpeed=heavy.hullDangerDuringRepair?emergencyEscapeSpeedV1(boat):14.6;
      remaining=moveHeavyToRepairPointV1(boat,destination,repairSpeed,dt,heavy.hullDangerDuringRepair?92:78);
    } else if (hullEscape) {
      const target=chooseTarget(world,boat),bomb=incomingMegaBomb(world,boat);
      const clearance=target?distance(boat,target.point):nearestPlayerDistance(world,boat);
      const quiet=now-(Number(heavy.lastDamageAt)||-999)>=HULL_STANDOFF_QUIET;
      if (heavy.hullEscapeMode==="standoff"&&(bomb||!quiet||clearance<HULL_STANDOFF_MIN-4)) resumeHullFlight(world,state,boat,heavy);
      if (heavy.hullEscapeMode==="standoff") {
        if (!target) boat.speed+=clamp(0-boat.speed,-8*dt,8*dt);
        else {
          boat.targetPlayer=target.index;
          if (clearance>HULL_STANDOFF_MAX||clearance<HULL_STANDOFF_MIN) {
            destination=hullStandoffPoint(world,boat,state,target);heavy.destination=destination;
            const speed=clearance<HULL_STANDOFF_MIN?emergencyEscapeSpeedV1(boat):Math.min(13.2,emergencyEscapeSpeedV1(boat));
            remaining=moveTo(boat,destination,speed,dt,clearance<HULL_STANDOFF_MIN?88:72);
          } else {
            heavy.destination=null;boat.speed+=clamp(0-boat.speed,-8*dt,8*dt);remaining=0;
          }
        }
      } else {
        destination=heavy.destination||resumeHullFlight(world,state,boat,heavy);
        const arrival=Math.max(16,Math.abs(Number(boat.speed)||0)*Math.max(0,dt)+7);
        if (distance(boat,destination)<=arrival) {
          heavy.destination=survivalPoint(world,boat,state);heavy.hullEscapeRerouteAt=now;destination=heavy.destination;
        }
        remaining=moveTo(boat,destination,emergencyEscapeSpeedV1(boat),dt,92);
        const rerouteDue=now-(Number(heavy.hullEscapeRerouteAt)||-999)>=0.8;
        if (rerouteDue&&(bomb||clearance<HULL_ESCAPE_CLEARANCE-28)) {
          heavy.destination=survivalPoint(world,boat,state);heavy.hullEscapeRerouteAt=now;
        }
        boat.speed=Math.max(Number(boat.speed)||0,emergencyEscapeSpeedV1(boat)*0.72);
        if (target&&now>=Number(heavy.minimumUntil)&&quiet&&!bomb&&clearance>=HULL_STANDOFF_MIN-4) enterHullStandoff(world,state,boat,heavy,target);
      }
    } else {
      destination=heavy.destination||safestPoint(world,boat,state,236);
      remaining=moveTo(boat,destination,18.5,dt,78);
    }
    if (heavy.escapeReason==="suppression") {
      const source=pointForPlayer(world,heavy.escapeSourcePlayer),far=!source||distance(boat,source)>=250;
      if (now>=heavy.minimumUntil&&(far||now>=heavy.maximumUntil)) {heavy.phase="returning";heavy.destination=heavy.combatPoint;heavy.escapeReason=null;}
    } else if (!hullEscape&&remaining<=REPAIR_ARRIVAL_RADIUS) {
      const clearance=nearestPlayerDistance(world,boat),required=requiredRepairClearanceV1(heavy);
      const quiet=now-(Number(heavy.lastDamageAt)||-999)>=1.2;
      const bomb=incomingMegaBomb(world,boat);
      if (quiet&&!bomb&&clearance>=required) {
        beginStoppingForRepair(world,boat,heavy);
      } else {
        const next=safestPoint(world,boat,state),nextClearance=nearestPlayerDistance(world,next);
        const improvement=nextClearance-clearance;
        if (quiet&&!bomb&&clearance>=REPAIR_ABORT_CLEARANCE+4&&improvement<12) {
          beginStoppingForRepair(world,boat,heavy);
        } else {
          heavy.destination=next;heavy.repairRouteClearance=nextClearance;heavy.repairReroutes=(Number(heavy.repairReroutes)||0)+1;
        }
      }
    }
  } else if (phase==="stopping") {
    if (heavy.repairSystem==="turret"&&(nearestPlayerDistance(world,boat)<REPAIR_ABORT_CLEARANCE||incomingMegaBomb(world,boat))) {
      heavy.phase="escape";heavy.escapeReason="repair";heavy.repairProgress*=0.35;assignRepairRoute(world,state,boat,heavy,true);boat.speed=Math.max(7.2,Number(boat.speed)||0);
      emit(world,"heavy-repair-aborted-v1","Ты подошёл слишком близко или запустил мега-бомбу. Катер сорвал остановку и снова уходит.",[0,1],{x:boat.x,y:boat.y});return;
    }
    boat.speed+=clamp(0-boat.speed,-5.8*dt,5.8*dt);const radians=boat.heading*Math.PI/180;
    boat.x=clamp(boat.x+Math.sin(radians)*boat.speed*dt,14,406);boat.y=clamp(boat.y-Math.cos(radians)*boat.speed*dt,84,310);
    if (Math.abs(boat.speed)<=0.3) {
      const system=heavy.repairSystem||"engine";
      boat.speed=0;heavy.phase="repairing";heavy.repairProgress=0;heavy.lastDamageAt=Math.min(Number(heavy.lastDamageAt)||-999,now-1.3);
      emit(world,"heavy-repair-start-v1",`Катер полностью остановился. Начат ремонт: ${system==="engine"?"двигатель":"оружейная установка"}.`,[0,1],{system,plates:heavy.repairPlates,x:boat.x,y:boat.y});
    }
  } else if (phase==="repairing") {
    boat.speed=0;
    if (heavy.repairSystem==="turret"&&(nearestPlayerDistance(world,boat)<REPAIR_ABORT_CLEARANCE||incomingMegaBomb(world,boat))) {
      heavy.phase="escape";heavy.escapeReason="repair";heavy.repairProgress*=0.35;assignRepairRoute(world,state,boat,heavy,true);boat.speed=7.2;
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
      heavy.repairPlates=Math.max(0,Number(heavy.repairPlates)-1);heavy.repairSystem=null;heavy.repairProgress=0;heavy.repairQuarter=0;
      heavy.repairRouteClearance=null;heavy.repairEscapeStartedAt=-999;heavy.repairReroutes=0;heavy.hullDangerDuringRepair=false;
      heavy.phase="returning";heavy.destination=heavy.combatPoint;heavy.escapeReason=null;
      emit(world,"heavy-repair-complete-v1",`Ремонт завершён. Осталось пластин: ${heavy.repairPlates}.`,[0,1],{system,plates:heavy.repairPlates,x:boat.x,y:boat.y});
    }
  } else if (phase==="returning") {
    if (Number(boat.engineHealth)<=0) {heavy.phase="stopping";heavy.repairSystem="engine";return;}
    if (moveHeavyToRepairPointV1(boat,heavy.destination||heavy.combatPoint,12.1,dt,62,8)<=0) {
      boat.speed=0;heavy.phase="combat";heavy.destination=null;heavy.escapeReason=null;
      emit(world,"heavy-repair-returned-v1","Тяжёлый катер вернулся в бой.",[0,1],{x:boat.x,y:boat.y});
    }
  }
  if (heavy.phase==="combat"||turretCanCover(boat,heavy)) resumeTurret(boat);
  else suspendTurret(boat);
}
export function finishHeavyAiControllerV1(world,dt) {
  const state=ensureControllerState(world),frame=state.frame||{eventStart:values(world.events).length,boat:snapshotBoat(currentHeavyBoat(world))};
  const directorId=world.freeThreatDirector?.active?String(world.freeThreatDirector.encounterId??""):null;
  if (frame.directorId!==undefined&&frame.directorId!==directorId&&frame.boat?.ref===world.freeHeavyPursuer?.boat) retireStaleHeavyV1(world,"encounter-changed",true);
  restoreDuplicateHeavy(world,state,frame);
  const boat=currentHeavyBoat(world),heavy=boat?ensureHeavy(world,state):null;
  if (boat&&heavy) {
    reconcileHeavyDamage(world,state,boat,heavy,frame);
    if (Number(boat.hull)>0) {
      if (boat.engineDisabled) startRecovery(world,state,boat,heavy,"engine");
      else if (boat.turretDisabled) startRecovery(world,state,boat,heavy,"turret");
      const newHits=recordAutomaticPressure(world,state,frame.eventStart);
      const danger=evaluateHullDangerV1(world,state,boat,heavy,frame);
      if (danger.shouldEscape&&heavy.repairSystem==="turret"&&["escape","stopping","repairing"].includes(heavy.phase)) {
        heavy.hullDangerDuringRepair=true;
        if (heavy.phase==="escape") boat.speed=Math.max(Number(boat.speed)||0,emergencyEscapeSpeedV1(boat)*0.78);
      }
      const canPromote=heavy.phase==="combat"||heavy.phase==="returning"
        ||(heavy.phase==="escape"&&["suppression","hull-danger","legacy"].includes(heavy.escapeReason));
      if (canPromote&&danger.shouldEscape) startHullDangerEscape(world,state,boat,heavy,danger);
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
