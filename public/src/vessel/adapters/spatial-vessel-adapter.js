"use strict";

import {compileSpatialLocation,createSpatialModuleRegistry} from "../../spatial/spatial-compiler.js";
import {SpatialRuntime} from "../../spatial/spatial-runtime.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "../../spatial/spatial-standard-modules.js";
import {applyMovingSpaceSample} from "../../spatial/spatial-moving-space-adapter.js";
import {projectVesselDefinitionToSpatial,vesselDeckSpatialSpaceId,vesselOccupantToSpatialLocal} from "./spatial-vessel-projection.js";

const mirrorsByWorld=new WeakMap();
const MIRRORED_TYPES=new Set(["dual-turret-patrol"]);

function worldMirrors(world){let map=mirrorsByWorld.get(world);if(!map){map=new Map();mirrorsByWorld.set(world,map);}return map;}
function occupantEntityId(index){return `vessel.occupant.${index}`;}

function createMirror(entry){
 const definition=projectVesselDefinitionToSpatial(entry.definition,{instanceId:entry.instance.instanceId});
 const registry=createSpatialModuleRegistry(STANDARD_SPATIAL_MODULE_TYPES);
 const compiled=compileSpatialLocation(definition,{moduleRegistry:registry,mode:"production"});
 const runtime=new SpatialRuntime(compiled);
 return {definition,compiled,runtime,instanceId:entry.instance.instanceId,typeId:entry.definition.id};
}

function syncOccupants(mirror,entry){
 const runtime=mirror.runtime,seen=new Set();
 for(const [rawIndex,position] of Object.entries(entry.instance?.occupants||{})){
  const index=Number(rawIndex);if(!Number.isInteger(index)||!position?.deckId)continue;
  const id=occupantEntityId(index),spaceId=vesselDeckSpatialSpaceId(position.deckId),local=vesselOccupantToSpatialLocal(position);seen.add(id);
  const existing=runtime.getEntity(id);
  if(existing?.spaceId!==spaceId){if(existing)runtime.removeEntity(id);try{runtime.placeEntity({id,kind:"player",label:`Игрок ${index+1}`,spaceId,position:local,mode:"foot",data:{playerIndex:index,vesselInstanceId:entry.instance.instanceId}});}catch{}continue;}
  if(existing){const previous=existing.localPosition||{};const changed=Math.hypot((Number(previous.x)||0)-local.x,(Number(previous.y)||0)-local.y,(Number(previous.z)||0)-local.z)>1e-6;if(changed)try{runtime.moveEntity(id,local);}catch{}}
 }
 for(const entity of runtime.listEntities())if(entity.id.startsWith("vessel.occupant.")&&!seen.has(entity.id))runtime.removeEntity(entity.id);
}

function syncMirror(mirror,entry){
 applyMovingSpaceSample(mirror.runtime,mirror.definition.projection.rootSpaceId,{coordinates:"world",position:{x:Number(entry.boat?.x)||0,y:Number(entry.boat?.y)||0,z:0},yaw:Number(entry.boat?.heading)||0});
 syncOccupants(mirror,entry);mirror.runtime.refreshActivity();return mirror;
}

export function syncFreeRoamVesselSpatialMirrors(world,nativeVessels,{typeIds=MIRRORED_TYPES}={}){
 const allowed=typeIds instanceof Set?typeIds:new Set(typeIds||[]),map=worldMirrors(world),seen=new Set();
 for(const entry of nativeVessels||[]){if(!entry?.definition?.capabilities?.walkableInterior||!allowed.has(entry.definition.id))continue;const id=entry.instance.instanceId;seen.add(id);let mirror=map.get(id);if(!mirror||mirror.typeId!==entry.definition.id){mirror=createMirror(entry);map.set(id,mirror);}syncMirror(mirror,entry);}
 for(const id of [...map.keys()])if(!seen.has(id))map.delete(id);
 return Object.freeze([...map.values()].map(mirror=>Object.freeze({instanceId:mirror.instanceId,typeId:mirror.typeId,locationId:mirror.compiled.id,revision:mirror.runtime.revision})));
}

export function freeRoamVesselSpatialMirror(world,instanceId){return worldMirrors(world).get(String(instanceId||""))||null;}
