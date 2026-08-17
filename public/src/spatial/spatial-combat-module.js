"use strict";

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function normalizeConfig(config={}){
 if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("combat config must be an object");
 return Object.freeze({barriers:Object.freeze((config.barriers||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`combat.barriers[${index}] must be an object`);
  const id=String(raw.id||"").trim(),spaceId=String(raw.spaceId||"").trim();if(!id||!spaceId)throw new TypeError(`combat barrier ${index} needs id and spaceId`);
  const c=raw.center||raw.position||{};const center={x:Number(c.x??c[0]??0),y:Number(c.y??c[1]??0),z:Number(c.z??c[2]??0)};if(!Object.values(center).every(Number.isFinite))throw new TypeError(`barrier ${id} center must be finite`);
  return Object.freeze({id,spaceId,center:Object.freeze(center),radius:Math.max(0.05,Number(raw.radius)||0.5),destructibleId:raw.destructibleId?String(raw.destructibleId):null});
 }))});
}
function segmentDistance(point,a,b){
 const ab={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};const ap={x:point.x-a.x,y:point.y-a.y,z:point.z-a.z};const len2=ab.x*ab.x+ab.y*ab.y+ab.z*ab.z;
 const t=len2?clamp((ap.x*ab.x+ap.y*ab.y+ap.z*ab.z)/len2,0,1):0;const q={x:a.x+ab.x*t,y:a.y+ab.y*t,z:a.z+ab.z*t};return Math.hypot(point.x-q.x,point.y-q.y,point.z-q.z);
}
export function createSpatialCombatService(config={}){
 const normalized=normalizeConfig(config);
 return Object.freeze({
  trace(runtime,{attackerId,targetId,destruction=null}={}){
   const attacker=runtime?.getEntity?.(attackerId),target=runtime?.getEntity?.(targetId);if(!attacker||!target)return Object.freeze({clear:false,reason:"missing-entity"});
   if(attacker.spaceId!==target.spaceId)return Object.freeze({clear:false,reason:"different-space",attackerSpaceId:attacker.spaceId,targetSpaceId:target.spaceId});
   const a=attacker.localPosition,b=target.localPosition;const distance=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);
   for(const barrier of normalized.barriers){if(barrier.spaceId!==attacker.spaceId)continue;if(barrier.destructibleId&&destruction&&!destruction.isBlocking(barrier.destructibleId,"sight"))continue;if(segmentDistance(barrier.center,a,b)<=barrier.radius)return Object.freeze({clear:false,reason:"blocked",blockerId:barrier.id,distance});}
   return Object.freeze({clear:true,reason:"clear",distance});
  },
  attack(runtime,{attackerId,targetId,damage=1,actors=null,destruction=null}={}){const trace=this.trace(runtime,{attackerId,targetId,destruction});if(!trace.clear)return Object.freeze({...trace,hit:false});const target=runtime.getEntity(targetId);const actorId=target?.data?.actorId;if(actorId&&actors)actors.damage(runtime,actorId,Math.max(0,Number(damage)||0),{sourceId:attackerId});return Object.freeze({...trace,hit:true,damage:Math.max(0,Number(damage)||0),actorId:actorId||null});},
 });
}
export const SPATIAL_COMBAT_MODULE_TYPE=Object.freeze({id:"spatial.combat",validateConfig(config){normalizeConfig(config||{});},create(context){return createSpatialCombatService(context.config||{});}});
