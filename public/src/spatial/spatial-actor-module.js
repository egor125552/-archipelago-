"use strict";

function normalizeConfig(config={}){
 if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("actors config must be an object");
 return Object.freeze({actors:Object.freeze((config.actors||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`actors[${index}] must be an object`);
  const id=String(raw.id||"").trim(),spaceId=String(raw.spaceId||"").trim();if(!id||!spaceId)throw new TypeError(`actor ${index} needs id and spaceId`);
  const p=raw.position||{};const position={x:Number(p.x??p[0]??0),y:Number(p.y??p[1]??0),z:Number(p.z??p[2]??0)};if(!Object.values(position).every(Number.isFinite))throw new TypeError(`actor ${id} position must be finite`);
  const maxHealth=Math.max(1,Number(raw.maxHealth)||100);
  return Object.freeze({id,label:String(raw.label||id),spaceId,position:Object.freeze(position),maxHealth,hostile:raw.hostile===true,kind:String(raw.kind||"npc")});
 }))});
}
export function createSpatialActorService(config={}, {emit=()=>{}}={}){
 const normalized=normalizeConfig(config);const defs=new Map(normalized.actors.map(v=>[v.id,v]));const states=new Map(normalized.actors.map(v=>[v.id,{health:v.maxHealth,alive:true,spawned:false}]));
 const entityId=id=>`actor.${id}`;
 function def(id){const found=defs.get(id);if(!found)throw new Error(`unknown actor ${id}`);return found;}
 function get(id){const d=def(id),s=states.get(id);return Object.freeze({...d,...s,entityId:entityId(id)});}
 return Object.freeze({
  get,list(){return Object.freeze([...defs.keys()].map(get));},
  spawn(runtime,id){const d=def(id),s=states.get(id);if(!s.alive)return get(id);if(!runtime.getEntity(entityId(id)))runtime.placeEntity({id:entityId(id),kind:"actor",label:d.label,spaceId:d.spaceId,position:d.position,mode:"foot",data:{actorId:id,hostile:d.hostile,actorKind:d.kind}});s.spawned=true;emit("actor.spawn",{actorId:id,entityId:entityId(id),spaceId:d.spaceId});return get(id);},
  despawn(runtime,id){def(id);runtime.removeEntity(entityId(id));states.get(id).spawned=false;emit("actor.despawn",{actorId:id});return get(id);},
  damage(runtime,id,amount,{sourceId=null}={}){const d=def(id),s=states.get(id);if(!s.alive)return get(id);const damage=Math.max(0,Number(amount)||0);s.health=Math.max(0,s.health-damage);emit("actor.damage",{actorId:id,damage,health:s.health,sourceId});if(s.health<=0){s.alive=false;s.spawned=false;runtime?.removeEntity?.(entityId(id));emit("actor.death",{actorId:id,sourceId});}return get(id);},
  serialize(){return Object.fromEntries([...states].map(([id,s])=>[id,{...s}]));},
  restore(snapshot={}){for(const [id,d] of defs){const raw=snapshot?.[id];if(!raw)continue;const health=Math.max(0,Math.min(d.maxHealth,Number(raw.health)||0));states.set(id,{health,alive:raw.alive!==false&&health>0,spawned:Boolean(raw.spawned)});}},
 });
}
export const SPATIAL_ACTORS_MODULE_TYPE=Object.freeze({id:"spatial.actors",validateConfig(config){normalizeConfig(config||{});},create(context){return createSpatialActorService(context.config||{},{emit:(kind,payload)=>context.emit(kind,payload)});}});
