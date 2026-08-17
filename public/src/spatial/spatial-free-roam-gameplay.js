"use strict";

import {computeSpatialFallDamage} from "./spatial-fall-module.js";
import {relativeSpatialDirection} from "./spatial-accessibility.js";
import {localToWorld} from "./spatial-transform.js";

const PLAYER_ENTITY_PREFIX="player.free.";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function entityId(index){return `${PLAYER_ENTITY_PREFIX}${index+1}`;}
function emit(world,type,text,targets,extra={}){world.events||=[];world.events.push({type,text,targets,at:Number(world.time)||0,operationEvent:true,spatialEvent:true,...extra});if(world.events.length>220)world.events.splice(0,world.events.length-220);}
function moduleService(runtime,type){const plan=runtime?.location?.modulePlans?.find(entry=>entry?.instance?.type===type&&!entry.disabledReason);return plan?runtime.getModule(plan.instance.id):null;}
function ensureState(world){world.spatialArchitecture||={};const state=world.spatialArchitecture;state.falls||=Array.from({length:world.players?.length||0},()=>null);while(state.falls.length<(world.players?.length||0))state.falls.push(null);state.gameplayRevision||={};state.fallCue||=Array.from({length:world.players?.length||0},()=>null);while(state.fallCue.length<(world.players?.length||0))state.fallCue.push(null);return state;}

export function prepareFreeRoamSpatialGameplayStep(world,manager){
 const state=ensureState(world);const players=(world.players||[]).map(player=>({mode:player.mode,airborne:Boolean(player.airborne),jumpHeight:Number(player.jumpHeight)||0,jumpVelocity:Number(player.jumpVelocity)||0,z:Number(player.z)||0,x:Number(player.x)||0,y:Number(player.y)||0,spatialLocationId:player.spatialLocationId||null,spatialSpaceId:player.spatialSpaceId||null}));
 const revisions={};for(const integration of manager?.integrations||[]){try{const runtime=integration.runtime(world);revisions[integration.compiled.id]=runtime.revision;}catch{}}
 return Object.freeze({players:Object.freeze(players),revisions:Object.freeze(revisions),fallState:Object.freeze(state.falls.map(entry=>entry?Object.freeze({...entry}):null))});
}

function startDrop(world,manager,index,player,state){
 const integration=manager?.byId?.get(player.spatialLocationId);if(!integration)return false;const runtime=integration.runtime(world);const fall=moduleService(runtime,"spatial.fall");if(!fall)return false;
 const worldZ=Number(player.spatialFloorZ||0)+Math.max(0,Number(player.jumpHeight)||0);const crossing=fall.findCrossing(runtime,{entityId:entityId(index),worldPosition:{x:Number(player.x)||0,y:Number(player.y)||0,z:worldZ}});if(!crossing)return false;
 fall.begin(runtime,entityId(index),crossing);const dropHeight=Math.max(0,worldZ-crossing.targetFloorZ);player.spatialSpaceId=crossing.toSpaceId;player.spatialFloorZ=crossing.targetFloorZ;player.jumpHeight=dropHeight;player.z=worldZ;player.airborne=true;if(!Number.isFinite(player.jumpVelocity))player.jumpVelocity=0;
 state.falls[index]={locationId:player.spatialLocationId,dropId:crossing.id,materialId:crossing.materialId,waterVolumeId:crossing.waterVolumeId||null,fromSpaceId:crossing.fromSpaceId,toSpaceId:crossing.toSpaceId,startWorldZ:worldZ,targetFloorZ:crossing.targetFloorZ,peakDownwardSpeed:Math.min(0,Number(player.jumpVelocity)||0)};
 state.fallCue[index]=null;
 emit(world,"location-fall-start",`Ты сорвался вниз. До нижней поверхности примерно ${Math.max(1,Math.round(dropHeight))} метров.`,[index],{sourcePlayer:index,locationId:player.spatialLocationId,dropId:crossing.id,fromSpaceId:crossing.fromSpaceId,spaceId:crossing.toSpaceId,x:player.x,y:player.y,z:worldZ,dropHeight});return true;
}

function landingText(result,waterDepth){if(result.damage<=0)return waterDepth>0?"Ты вошёл в воду после падения без травмы.":"Ты приземлился без травмы.";if(result.damage>=100)return "Удар после падения оказался смертельным.";if(result.damage>=45)return `Очень тяжёлое приземление. Урон ${Math.round(result.damage)}.`;return `Жёсткое приземление. Урон ${Math.round(result.damage)}.`;}
function finishLanding(world,manager,index,player,before,state,applyCombatDamage){
 const fallState=state.falls[index];if(!fallState)return false;fallState.peakDownwardSpeed=Math.min(Number(fallState.peakDownwardSpeed)||0,Number(before?.jumpVelocity)||0);
 if(player.airborne||!before?.airborne)return false;
 const integration=manager?.byId?.get(fallState.locationId);if(!integration){state.falls[index]=null;return false;}const runtime=integration.runtime(world);const materials=moduleService(runtime,"spatial.materials");const water=moduleService(runtime,"spatial.water");
 const sample=water?.sample?.({spaceId:fallState.toSpaceId,volumeId:fallState.waterVolumeId});const waterDepth=Math.max(0,Number(sample?.depth)||0);const impactSpeed=Math.abs(Math.min(0,Number(fallState.peakDownwardSpeed)||0,Number(before.jumpVelocity)||0));
 const materialImpact=materials?.impact?.({speed:impactSpeed,materialId:fallState.materialId,spaceId:fallState.toSpaceId,waterDepth})||{effectiveSpeed:impactSpeed};const result=computeSpatialFallDamage({impactSpeed,materialImpact});
 emit(world,"location-fall-land",landingText(result,waterDepth),[index],{sourcePlayer:index,locationId:fallState.locationId,dropId:fallState.dropId,spaceId:fallState.toSpaceId,impactSpeed,effectiveSpeed:result.effectiveSpeed,damage:result.damage,severity:result.severity,waterDepth,x:player.x,y:player.y,z:Number(player.spatialFloorZ)||0});
 if(result.damage>0&&typeof applyCombatDamage==="function")applyCombatDamage(world,index,result.damage,-1,{weapon:"fall",heavy:result.damage>=35,eventType:"fall-damage",announceHealth:true,sourcePoint:{x:player.x,y:player.y}});
 state.falls[index]=null;return true;
}

function tickRuntimeModules(world,integration,runtime,dt,fromRevision){
 const water=moduleService(runtime,"spatial.water");water?.tick?.(dt);
 const destruction=moduleService(runtime,"spatial.destruction");destruction?.sync?.(runtime);
 const actors=moduleService(runtime,"spatial.actors");for(const actor of actors?.list?.()||[]){if(actor.alive&&!runtime.getEntity(actor.entityId))try{actors.spawn(runtime,actor.id);}catch{}}
 const items=moduleService(runtime,"spatial.items");for(const item of items?.list?.()||[]){if(item.state==="world"&&!runtime.getEntity(item.entityId))try{items.spawn(runtime,item.id);}catch{}}
 const quests=moduleService(runtime,"spatial.quests");if(quests){for(const event of runtime.events||[]){if(Number(event.revision)<=Number(fromRevision||0))continue;quests.ingest(event);}}
 if(runtime.revision!==fromRevision)integration.persist(world,runtime);
}

function announceDropEdges(world,manager,index,player,state){
 if(!player||player.mode!=="foot"||player.airborne||!player.spatialLocationId)return;
 const integration=manager?.byId?.get(player.spatialLocationId);if(!integration)return;const runtime=integration.runtime(world);const fall=moduleService(runtime,"spatial.fall");if(!fall)return;const entity=runtime.getEntity(entityId(index));if(!entity)return;
 let best=null;for(const drop of fall.list()){if(drop.fromSpaceId!==entity.spaceId)continue;const space=runtime.location.spacesById.get(entity.spaceId);const xs=space.shape.outer.map(p=>p.x),ys=space.shape.outer.map(p=>p.y);const b={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};const axis=drop.edge.axis,other=axis==="x"?"y":"x",boundary=axis==="x"?(drop.edge.side==="min"?b.minX:b.maxX):(drop.edge.side==="min"?b.minY:b.maxY);const along=clamp(entity.localPosition[other],drop.edge.rangeMin,drop.edge.rangeMax);const metres=Math.hypot(entity.localPosition[axis]-boundary,entity.localPosition[other]-along);if(metres<=4&&(!best||metres<best.metres))best={drop,metres};}
 if(best){const drop=best.drop,space=runtime.location.spacesById.get(entity.spaceId);const axis=drop.edge.axis,other=axis==="x"?"y":"x";const xs=space.shape.outer.map(p=>p.x),ys=space.shape.outer.map(p=>p.y);const b={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};const boundary=axis==="x"?(drop.edge.side==="min"?b.minX:b.maxX):(drop.edge.side==="min"?b.minY:b.maxY);const localTarget={x:entity.localPosition.x,y:entity.localPosition.y,z:entity.localPosition.z};localTarget[axis]=boundary;localTarget[other]=clamp(entity.localPosition[other],drop.edge.rangeMin,drop.edge.rangeMax);const target=localToWorld(runtime.location,entity.spaceId,localTarget,runtime.dynamicTransforms);best.direction=relativeSpatialDirection(player,target);}
 const key=best?`${player.spatialLocationId}:${best.drop.id}:${best.metres<=1.5?"ready":"near"}:${best.direction}`:null;if(key&&state.fallCue[index]!==key){emit(world,"location-fall-edge",best.metres<=1.5?`Край ${best.drop.label} рядом ${best.direction}. Шагни дальше ${best.direction}, чтобы спрыгнуть.`:`Рядом ${best.drop.label}, примерно ${Math.max(1,Math.round(best.metres))} метров ${best.direction}.`,[index],{sourcePlayer:index,locationId:player.spatialLocationId,dropId:best.drop.id,distance:best.metres,direction:best.direction});}state.fallCue[index]=key;
}

export function finishFreeRoamSpatialGameplayStep(world,manager,context,dt,{applyCombatDamage=null}={}){
 const state=ensureState(world);const before=context?.players||[];
 for(let index=0;index<(world.players||[]).length;index+=1){const player=world.players[index];if(!player)continue;if(state.falls[index])finishLanding(world,manager,index,player,before[index],state,applyCombatDamage);else if(player.mode==="foot"&&player.spatialLocationId)startDrop(world,manager,index,player,state);}
 for(const integration of manager?.integrations||[]){const runtime=integration.runtime(world);tickRuntimeModules(world,integration,runtime,Math.max(0,Number(dt)||0),context?.revisions?.[integration.compiled.id]||0);}
 return world;
}

export function announceFreeRoamSpatialGameplay(world,manager){const state=ensureState(world);for(let index=0;index<(world.players||[]).length;index+=1)announceDropEdges(world,manager,index,world.players[index],state);return world;}

export function spatialGameplayStatus(world,manager,index){const state=ensureState(world);const fall=state.falls[index];if(!fall)return "";const player=world.players?.[index];const metres=Math.max(0,(Number(player?.z)||0)-(Number(fall.targetFloorZ)||0));return `Падение: до поверхности примерно ${Math.max(1,Math.round(metres))} метров.`;}
