"use strict";

import {resolveSpaceWorldTransform, spaceContainsLocalPoint, worldToLocal} from "./spatial-transform.js";

function normalizeConfig(config={}){
 if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("fall config must be an object");
 return Object.freeze({drops:Object.freeze((config.drops||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`fall.drops[${index}] must be an object`);
  const id=String(raw.id||"").trim(),fromSpaceId=String(raw.fromSpaceId||"").trim(),toSpaceId=String(raw.toSpaceId||"").trim();if(!id||!fromSpaceId||!toSpaceId)throw new TypeError(`fall drop ${index} needs id, fromSpaceId and toSpaceId`);
  const edge=raw.edge||{};const axis=edge.axis==="x"?"x":"y";const side=edge.side==="min"?"min":"max";
  const rangeMin=Number(edge.rangeMin??-Infinity),rangeMax=Number(edge.rangeMax??Infinity);if(Number.isNaN(rangeMin)||Number.isNaN(rangeMax)||rangeMax<rangeMin)throw new TypeError(`fall drop ${id} has invalid edge range`);
  return Object.freeze({id,label:String(raw.label||"край"),fromSpaceId,toSpaceId,edge:Object.freeze({axis,side,rangeMin,rangeMax,approach:Math.max(0.2,Number(edge.approach)||1.5)}),materialId:String(raw.materialId||"concrete"),waterVolumeId:raw.waterVolumeId?String(raw.waterVolumeId):null});
 }))});
}
function bounds(space){const xs=space.shape.outer.map(p=>p.x),ys=space.shape.outer.map(p=>p.y);return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};}
function crossing(drop,space,previousLocal,attemptLocal){const b=bounds(space),axis=drop.edge.axis,other=axis==="x"?"y":"x",boundary=axis==="x"?(drop.edge.side==="min"?b.minX:b.maxX):(drop.edge.side==="min"?b.minY:b.maxY);const direction=drop.edge.side==="min"?-1:1;const prevDelta=(previousLocal[axis]-boundary)*direction,nextDelta=(attemptLocal[axis]-boundary)*direction;return prevDelta<=0&&prevDelta>=-drop.edge.approach&&nextDelta>0&&attemptLocal[other]>=drop.edge.rangeMin&&attemptLocal[other]<=drop.edge.rangeMax;}
export function createSpatialFallService(config={}){const normalized=normalizeConfig(config);return Object.freeze({list(){return normalized.drops;},findCrossing(runtime,{entityId,worldPosition}){const entity=runtime?.getEntity?.(entityId);if(!entity)return null;const space=runtime.location.spacesById.get(entity.spaceId);if(!space)return null;const attempt=worldToLocal(runtime.location,entity.spaceId,worldPosition,runtime.dynamicTransforms);for(const drop of normalized.drops){if(drop.fromSpaceId!==entity.spaceId||!crossing(drop,space,entity.localPosition,attempt))continue;const targetSpace=runtime.location.spacesById.get(drop.toSpaceId);if(!targetSpace)continue;const floor=resolveSpaceWorldTransform(runtime.location,drop.toSpaceId,runtime.dynamicTransforms).position.z;const targetLocal=worldToLocal(runtime.location,drop.toSpaceId,{x:worldPosition.x,y:worldPosition.y,z:Math.max(worldPosition.z,floor)},runtime.dynamicTransforms);if(!spaceContainsLocalPoint(targetSpace,targetLocal))continue;return Object.freeze({...drop,targetLocal:Object.freeze(targetLocal),targetFloorZ:floor,startWorldZ:worldPosition.z});}return null;},begin(runtime,entityId,drop){const entity=runtime.getEntity(entityId);if(!entity||!drop)return null;runtime.removeEntity(entityId);runtime.placeEntity({id:entity.id,kind:entity.kind,label:entity.label,spaceId:drop.toSpaceId,position:drop.targetLocal,mode:entity.mode,data:entity.data});return runtime.getEntity(entityId);}});}
export const SPATIAL_FALL_MODULE_TYPE=Object.freeze({id:"spatial.fall",validateConfig(config){normalizeConfig(config||{});},create(context){return createSpatialFallService(context.config||{});}});

export function computeSpatialFallDamage({impactSpeed,materialImpact=null}={}){
 const speed=Math.max(0,Number(impactSpeed)||0);const effective=materialImpact?.effectiveSpeed??speed;
 const safe=6.2;if(effective<=safe)return Object.freeze({damage:0,severity:"safe",impactSpeed:speed,effectiveSpeed:effective});
 const excess=effective-safe;const damage=Math.min(200,excess*excess*2.25 + excess*3.2);return Object.freeze({damage:Math.round(damage*10)/10,severity:damage>=100?"lethal":damage>=45?"severe":damage>=12?"injury":"minor",impactSpeed:speed,effectiveSpeed:effective});
}
