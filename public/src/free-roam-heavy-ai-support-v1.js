"use strict";

import {resolveCombatTarget} from "./free-roam-targeting.js?v=39";

export const HEAVY_TARGET_IDS = new Set(["heavy-pursuer", "heavy-turret", "heavy-engine"]);
export const MEGA_BOMB_RANGE = 320;
export const BOUNDS = Object.freeze({minX:14,maxX:406,minY:84,maxY:310});
export const values = value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
export const clamp = (value,min,max) => Math.max(min,Math.min(max,Number(value)||0));
export const distance = (a,b) => Math.hypot((Number(a?.x)||0)-(Number(b?.x)||0),(Number(a?.y)||0)-(Number(b?.y)||0));
export const wrap = value => ((Number(value)+180)%360+360)%360-180;
export const bearing = (a,b) => Math.atan2((Number(b?.x)||0)-(Number(a?.x)||0),-((Number(b?.y)||0)-(Number(a?.y)||0)))*180/Math.PI;

export function emit(world,type,text,targets=[0,1],extra={}) {
  world.events ||= [];
  world.events.push({type,text,targets,at:world.time,operationEvent:true,...extra});
  if (world.events.length>180) world.events.splice(0,world.events.length-180);
}
export function pointForPlayer(world,index) {
  const player=world.players?.[index];
  if (!player) return null;
  if (["boat","roof"].includes(player.mode)) return values(world.boats).find(b=>String(b?.id)===String(player.activeBoat))||world.boats?.[player.activeBoat]||player;
  return player;
}
export function livingPlayers(world) {
  return values(world.players).map((player,index)=>({player,index,point:pointForPlayer(world,index)}))
    .filter(({player,index,point})=>world.freeActivities?.presence?.[index]!==false&&player?.combat?.alive&&point);
}
export function currentHeavyBoat(world) {
  const boat=world.freeHeavyPursuer?.boat;
  return boat?.active&&!boat.destroyed&&Number(boat.hull)>0?boat:null;
}
export function heavyEncounterId(world,boat) {
  const director=world.freeThreatDirector;
  if (director?.active&&Number(director.level)>=5&&!director.heavyStarted) {
    return Number(world.freeHeavyPursuer?.encounterId)||world.freeHeavyAiControllerV1?.encounterId||String(boat?.id||"heavy-pursuer");
  }
  return Number(director?.encounterId)||Number(world.freeHeavyPursuer?.encounterId)||String(boat?.id||"heavy-pursuer");
}
export function ensureControllerState(world) {
  world.freeHeavyAiControllerV1 ||= {heavy:null,encounterId:null,frame:null,serial:0,targetLocks:{},automaticHits:[],lastWindupAt:-999};
  const state=world.freeHeavyAiControllerV1;
  state.targetLocks ||= {};
  if (!Array.isArray(state.automaticHits)) state.automaticHits=[];
  if (!Number.isFinite(state.serial)) state.serial=0;
  const old=world.freeCombatAiV164;
  if (!state.heavy&&old?.heavy) state.heavy=old.heavy;
  if (state.encounterId==null&&old?.heavyEncounterId!=null) state.encounterId=old.heavyEncounterId;
  for (let version=165;version<=176;version+=1) delete world[`freeCombatAiV${version}`];
  publishCompatibility(world,state);
  return state;
}
export function publishCompatibility(world,state) {
  world.freeCombatAiV164 ||= {};
  Object.assign(world.freeCombatAiV164,{heavy:state.heavy,heavyEncounterId:state.encounterId,frame:null,owner:"free-heavy-ai-controller-v1"});
}
export function snapshotBoat(boat) {
  return boat&&{ref:boat,data:{...boat},x:boat.x,y:boat.y,heading:boat.heading,speed:boat.speed,hull:boat.hull,maxHull:boat.maxHull,
    engineHealth:boat.engineHealth,turretHealth:boat.turretHealth,engineDisabled:boat.engineDisabled,turretDisabled:boat.turretDisabled,
    fireCooldown:boat.fireCooldown,burstRemaining:boat.burstRemaining,aimRemaining:boat.aimRemaining,turretHeading:boat.turretHeading};
}
export function restorePosition(boat,frame) {
  if (boat&&frame?.boat) Object.assign(boat,{x:frame.boat.x,y:frame.boat.y,heading:frame.boat.heading,speed:frame.boat.speed});
}
export function moveTo(boat,destination,speed,dt,turnRate=72) {
  if (!destination) return Infinity;
  const wanted=bearing(boat,destination),error=wrap(wanted-boat.heading);
  boat.heading=wrap(boat.heading+clamp(error,-turnRate*dt,turnRate*dt));
  const wantedSpeed=Math.abs(error)>120?speed*0.65:speed;
  boat.speed+=clamp(wantedSpeed-boat.speed,-12*dt,14*dt);
  const radians=boat.heading*Math.PI/180;
  boat.x=clamp(boat.x+Math.sin(radians)*boat.speed*dt,BOUNDS.minX,BOUNDS.maxX);
  boat.y=clamp(boat.y-Math.cos(radians)*boat.speed*dt,BOUNDS.minY,BOUNDS.maxY);
  return distance(boat,destination);
}
export function safestPoint(world,boat,state,clearance=236) {
  state.serial+=1;
  const people=livingPlayers(world),points=[];
  for (const x of [16,42,88,150,210,272,334,380,404]) for (const y of [86,108,150,200,250,292,308]) points.push({x,y});
  return points.map(point=>({point,nearest:people.length?Math.min(...people.map(p=>distance(point,p.point))):999,travel:distance(point,boat)}))
    .filter(item=>item.travel>=20)
    .sort((a,b)=>(b.nearest>=clearance)-(a.nearest>=clearance)||b.nearest-a.nearest||b.travel-a.travel)[0]?.point
    ||{x:clamp(boat.x,16,404),y:clamp(boat.y,86,308)};
}
export function nearestPlayerDistance(world,point) {
  const people=livingPlayers(world);
  return people.length?Math.min(...people.map(item=>distance(point,item.point))):Infinity;
}
export function incomingMegaBomb(world,boat) {
  return values(world.freeMegaBombs?.projectiles).some(projectile=>projectile&&Number(projectile.energy)>0
    &&(!Number.isFinite(Number(projectile.ttl))||Number(projectile.ttl)>0)
    &&(HEAVY_TARGET_IDS.has(String(projectile.targetId||""))
      ||distance({x:projectile.targetX??projectile.x,y:projectile.targetY??projectile.y},boat)<=105
      ||distance(projectile,boat)<=145));
}
export function retireStaleHeavyV1(world,reason="stale",force=false) {
  const state=ensureControllerState(world),boat=currentHeavyBoat(world),director=world.freeThreatDirector;
  if (!boat) return false;
  const known=String(world.freeHeavyPursuer?.encounterId??state.heavy?.encounterId??state.encounterId??"");
  const current=director?.active&&Number(director.level)>=5?String(director.encounterId??""):known;
  const adoptionDue=director?.active&&Number(director.level)>=5&&!director.heavyStarted
    &&(Number(world.time)||0)+0.07>=(Number(director.heavyStartsAt)||Infinity);
  if (!force&&(!director?.active||Number(director.level)<5||!known||known===current||adoptionDue)) return false;
  Object.assign(world.freeHeavyPursuer,{active:false,boat:null,encounterId:null,projectiles:[],nextProjectileId:1});
  state.heavy=null;state.encounterId=null;state.targetLocks={};
  if (world.freeHostileActors?.actors) world.freeHostileActors.actors=values(world.freeHostileActors.actors).filter(actor=>String(actor?.boatId)!=="heavy-pursuer");
  for (const player of values(world.players)) if (HEAVY_TARGET_IDS.has(String(player?.combat?.lockedTargetId||""))) player.combat.lockedTargetId=null;
  emit(world,"heavy-stale-state-retired-v1","",[],{reason});
  publishCompatibility(world,state);
  return true;
}
export function reconcileHeavyDamage(world,state,boat,heavy,frame) {
  if (!frame?.boat) return;
  const start=frame.eventStart,events=values(world.events).slice(start);
  const engineDelta=Math.max(0,(Number(frame.boat.engineHealth)||0)-(Number(boat.engineHealth)||0));
  const turretDelta=Math.max(0,(Number(frame.boat.turretHealth)||0)-(Number(boat.turretHealth)||0));
  const hullDelta=Math.max(0,(Number(frame.boat.hull)||0)-(Number(boat.hull)||0));
  if (engineDelta||turretDelta||hullDelta) heavy.lastDamageAt=Number(world.time)||0;
  if (!heavy.armourBreached) {
    if (engineDelta) boat.engineHealth=clamp(frame.boat.engineHealth-engineDelta*0.3,0,boat.maxEngineHealth||180);
    if (turretDelta) boat.turretHealth=clamp(frame.boat.turretHealth-turretDelta*0.3,0,boat.maxTurretHealth||240);
  } else {
    if (engineDelta) boat.engineHealth=clamp(frame.boat.engineHealth-engineDelta*2.5,0,boat.maxEngineHealth||180);
    if (turretDelta) boat.turretHealth=clamp(frame.boat.turretHealth-turretDelta*2.5,0,boat.maxTurretHealth||240);
    for (const event of events) if (event.type==="armoured-target"&&(!event.weapon||event.weapon==="pistol")) {
      const component=event.component||"hull",damage=component==="hull"?9:16;
      if (component==="engine") boat.engineHealth=clamp(boat.engineHealth-damage,0,boat.maxEngineHealth||180);
      else if (component==="turret") boat.turretHealth=clamp(boat.turretHealth-damage,0,boat.maxTurretHealth||240);
      else boat.hull=clamp(boat.hull-damage,0,boat.maxHull||heavy.coreMax);
      event.type="heavy-component-hit";event.weapon="pistol";event.text="Пистолет попал в открытую часть тяжёлого катера.";
    }
  }
  boat.engineDisabled=Number(boat.engineHealth)<=0;
  boat.turretDisabled=Number(boat.turretHealth)<=0;
  const armourGone=!heavy.armourBreached&&(Number(boat.hull)<=0||boat.destroyed||events.some(event=>event.type==="heavy-pursuer-destroyed"));
  if (armourGone) {
    world.events=values(world.events).filter((event,index)=>index<start||event.type!=="heavy-pursuer-destroyed");
    heavy.armourBreached=true;boat.active=true;boat.destroyed=false;world.freeHeavyPursuer.active=true;
    boat.maxHull=heavy.coreMax;boat.hull=heavy.coreMax;
    emit(world,"heavy-armour-breached","Броневой корпус сорван. Открыты внутренний корпус, двигатель и установка.",[0,1],{core:boat.hull,x:boat.x,y:boat.y});
  }
}
export function preserveHeavyTargetLocks(world,state,start) {
  for (let index=0;index<values(world.players).length;index+=1) {
    const combat=world.players?.[index]?.combat;
    if (!combat?.alive) continue;
    const input=world.freeActivities?.inputs?.[index]||world.operationInputs?.[index]||world.inputs?.[index]||{};
    const id=input.targetId||combat.lastTargetRequestId||combat.lockedTargetId;
    if (!id) continue;
    const target=resolveCombatTarget(world,index,id,Infinity);
    if (!target?.point) continue;
    const metres=distance(pointForPlayer(world,index),target.point);
    if (metres<=MEGA_BOMB_RANGE) {
      const changed=state.targetLocks[index]?.id!==target.id;
      combat.lockedTargetId=target.id;state.targetLocks[index]={id:target.id};
      world.events=values(world.events).filter((event,eventIndex)=>eventIndex<start||!(event.targets?.includes?.(index)&&["target-cleared","target-lost"].includes(event.type)));
      if (changed&&metres>220) emit(world,"target-locked-long-range-v1",`Цель жива и захвачена на дистанции ${Math.round(metres)} метров. Автомат не достаёт, но мега-бомба может достать.`,[index],{sourcePlayer:index,targetId:target.id,distance:metres});
    } else if (combat.lockedTargetId===target.id) combat.lockedTargetId=null;
  }
}
export function cleanHeavyEvents(world,state,start) {
  const prefix=values(world.events).slice(0,start),fresh=[];
  for (const event of values(world.events).slice(start)) {
    if (["heavy-repair-retreat","heavy-repair-start","heavy-repair-progress","heavy-repair-complete"].includes(event.type)) continue;
    if (event.type==="heavy-gun-windup") {
      const at=Number(event.at??world.time)||0;
      if (at-state.lastWindupAt<0.75) continue;
      state.lastWindupAt=at;
    }
    if (event.type==="heavy-gun-shot"&&!(world.freeActivities?.presence?.[event.targetPlayer]!==false&&world.players?.[event.targetPlayer]?.combat?.alive)) continue;
    if (event.type==="heavy-bullet-boat-hit") {
      const boat=values(world.boats).find(item=>String(item?.id)===String(event.targetBoat));
      if (!boat||boat.sunk||Number(boat.hull)<=0) continue;
    }
    fresh.push(event);
  }
  world.events=[...prefix,...fresh];
}
