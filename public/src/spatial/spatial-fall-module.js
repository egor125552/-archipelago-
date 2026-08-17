"use strict";

import {resolveSpaceWorldTransform, spaceContainsLocalPoint, worldToLocal} from "./spatial-transform.js";

const ALL_AUTO_EDGES = Object.freeze(["x:min", "x:max", "y:min", "y:max"]);

function normalizeAutoEdgeKey(value, field) {
  const key = String(value || "").trim();
  if (!ALL_AUTO_EDGES.includes(key)) throw new TypeError(`${field} must be one of ${ALL_AUTO_EDGES.join(", ")}`);
  return key;
}

function normalizeConfig(config={}){
 if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("fall config must be an object");
 const drops=Object.freeze((config.drops||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`fall.drops[${index}] must be an object`);
  const id=String(raw.id||"").trim(),fromSpaceId=String(raw.fromSpaceId||"").trim(),toSpaceId=String(raw.toSpaceId||"").trim();if(!id||!fromSpaceId||!toSpaceId)throw new TypeError(`fall drop ${index} needs id, fromSpaceId and toSpaceId`);
  const edge=raw.edge||{};const axis=edge.axis==="x"?"x":"y";const side=edge.side==="min"?"min":"max";
  const rangeMin=Number(edge.rangeMin??-Infinity),rangeMax=Number(edge.rangeMax??Infinity);if(Number.isNaN(rangeMin)||Number.isNaN(rangeMax)||rangeMax<rangeMin)throw new TypeError(`fall drop ${id} has invalid edge range`);
  return Object.freeze({id,label:String(raw.label||"край"),fromSpaceId,toSpaceId,edge:Object.freeze({axis,side,rangeMin,rangeMax,approach:Math.max(0.2,Number(edge.approach)||1.5)}),materialId:String(raw.materialId||"concrete"),waterVolumeId:raw.waterVolumeId?String(raw.waterVolumeId):null});
 }));
 const autoEdges=Object.freeze((config.autoEdges||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`fall.autoEdges[${index}] must be an object`);
  const idPrefix=String(raw.idPrefix||"").trim(),fromSpaceId=String(raw.fromSpaceId||"").trim(),toSpaceId=String(raw.toSpaceId||"").trim();
  if(!idPrefix||!fromSpaceId||!toSpaceId)throw new TypeError(`fall auto edge ${index} needs idPrefix, fromSpaceId and toSpaceId`);
  const edgeList=raw.edges==null||raw.edges==="all"?ALL_AUTO_EDGES:(Array.isArray(raw.edges)?raw.edges:[]);
  if(!edgeList.length)throw new TypeError(`fall auto edge ${idPrefix} needs edges or \"all\"`);
  const edges=Object.freeze([...new Set(edgeList.map((entry,edgeIndex)=>normalizeAutoEdgeKey(entry,`fall.autoEdges[${index}].edges[${edgeIndex}]`)))]);
  return Object.freeze({idPrefix,label:String(raw.label||"край"),fromSpaceId,toSpaceId,edges,approach:Math.max(0.2,Number(raw.approach)||1.5),materialId:String(raw.materialId||"concrete"),waterVolumeId:raw.waterVolumeId?String(raw.waterVolumeId):null});
 }));
 return Object.freeze({drops,autoEdges});
}
function bounds(space){const xs=space.shape.outer.map(p=>p.x),ys=space.shape.outer.map(p=>p.y);return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};}
function locationSpaceMap(location){if(location?.spacesById instanceof Map)return location.spacesById;return new Map((location?.spaces||[]).map(space=>[space.id,space]));}
function expandAutoEdges(normalized,location){
 const spaces=locationSpaceMap(location);const result=[];const seen=new Set(normalized.drops.map(drop=>drop.id));
 for(const spec of normalized.autoEdges){
  const fromSpace=spaces.get(spec.fromSpaceId),toSpace=spaces.get(spec.toSpaceId);if(!fromSpace)throw new TypeError(`fall auto edge ${spec.idPrefix} uses missing fromSpaceId ${spec.fromSpaceId}`);if(!toSpace)throw new TypeError(`fall auto edge ${spec.idPrefix} uses missing toSpaceId ${spec.toSpaceId}`);
  const b=bounds(fromSpace);
  for(const key of spec.edges){
   const [axis,side]=key.split(":");const other=axis==="x"?"y":"x";const rangeMin=other==="x"?b.minX:b.minY;const rangeMax=other==="x"?b.maxX:b.maxY;const id=`${spec.idPrefix}.${axis}.${side}`;
   if(seen.has(id))throw new TypeError(`duplicate fall drop id ${id}`);seen.add(id);
   result.push(Object.freeze({id,label:spec.label,fromSpaceId:spec.fromSpaceId,toSpaceId:spec.toSpaceId,edge:Object.freeze({axis,side,rangeMin,rangeMax,approach:spec.approach}),materialId:spec.materialId,waterVolumeId:spec.waterVolumeId}));
  }
 }
 return Object.freeze(result);
}
function crossing(drop,space,previousLocal,attemptLocal){const b=bounds(space),axis=drop.edge.axis,other=axis==="x"?"y":"x",boundary=axis==="x"?(drop.edge.side==="min"?b.minX:b.maxX):(drop.edge.side==="min"?b.minY:b.maxY);const direction=drop.edge.side==="min"?-1:1;const prevDelta=(previousLocal[axis]-boundary)*direction,nextDelta=(attemptLocal[axis]-boundary)*direction;return prevDelta<=0&&prevDelta>=-drop.edge.approach&&nextDelta>0&&attemptLocal[other]>=drop.edge.rangeMin&&attemptLocal[other]<=drop.edge.rangeMax;}
export function createSpatialFallService(config={},location=null){const normalized=normalizeConfig(config);const drops=Object.freeze([...normalized.drops,...expandAutoEdges(normalized,location)]);return Object.freeze({list(){return drops;},findCrossing(runtime,{entityId,worldPosition}){const entity=runtime?.getEntity?.(entityId);if(!entity)return null;const space=runtime.location.spacesById.get(entity.spaceId);if(!space)return null;const attempt=worldToLocal(runtime.location,entity.spaceId,worldPosition,runtime.dynamicTransforms);for(const drop of drops){if(drop.fromSpaceId!==entity.spaceId||!crossing(drop,space,entity.localPosition,attempt))continue;const targetSpace=runtime.location.spacesById.get(drop.toSpaceId);if(!targetSpace)continue;const floor=resolveSpaceWorldTransform(runtime.location,drop.toSpaceId,runtime.dynamicTransforms).position.z;const targetLocal=worldToLocal(runtime.location,drop.toSpaceId,{x:worldPosition.x,y:worldPosition.y,z:Math.max(worldPosition.z,floor)},runtime.dynamicTransforms);if(!spaceContainsLocalPoint(targetSpace,targetLocal))continue;return Object.freeze({...drop,targetLocal:Object.freeze(targetLocal),targetFloorZ:floor,startWorldZ:worldPosition.z});}return null;},begin(runtime,entityId,drop){const entity=runtime.getEntity(entityId);if(!entity||!drop)return null;runtime.removeEntity(entityId);runtime.placeEntity({id:entity.id,kind:entity.kind,label:entity.label,spaceId:drop.toSpaceId,position:drop.targetLocal,mode:entity.mode,data:entity.data});return runtime.getEntity(entityId);}});}
export const SPATIAL_FALL_MODULE_TYPE=Object.freeze({id:"spatial.fall",validateConfig(config,{location}={}){const normalized=normalizeConfig(config||{});expandAutoEdges(normalized,location);},create(context){return createSpatialFallService(context.config||{},context.read?.location||null);}});

export function computeSpatialFallDamage({impactSpeed,materialImpact=null}={}){
 const speed=Math.max(0,Number(impactSpeed)||0);const effective=materialImpact?.effectiveSpeed??speed;
 const safe=6.2;if(effective<=safe)return Object.freeze({damage:0,severity:"safe",impactSpeed:speed,effectiveSpeed:effective});
 const excess=effective-safe;const damage=Math.min(200,excess*excess*2.25 + excess*3.2);return Object.freeze({damage:Math.round(damage*10)/10,severity:damage>=100?"lethal":damage>=45?"severe":damage>=12?"injury":"minor",impactSpeed:speed,effectiveSpeed:effective});
}
