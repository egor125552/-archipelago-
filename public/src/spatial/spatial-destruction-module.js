"use strict";

function finite(value,field,fallback=null){if(value==null&&fallback!=null)return fallback;const n=Number(value);if(!Number.isFinite(n))throw new TypeError(`${field} must be finite`);return n;}
function normalizeConfig(config={}){
 if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("destruction config must be an object");
 return Object.freeze({targets:Object.freeze((config.targets||[]).map((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`destruction.targets[${index}] must be an object`);
  const id=String(raw.id||"").trim(); if(!id)throw new TypeError(`destruction.targets[${index}].id is required`);
  const maxHealth=Math.max(0.001,finite(raw.maxHealth,`${id}.maxHealth`,100));
  return Object.freeze({id,label:String(raw.label||id),maxHealth,initialHealth:Math.max(0,Math.min(maxHealth,finite(raw.initialHealth,`${id}.initialHealth`,maxHealth))),materialId:String(raw.materialId||"concrete"),connectionId:raw.connectionId?String(raw.connectionId):null,destroyedState:String(raw.destroyedState||"destroyed"),blocksMovement:raw.blocksMovement!==false,blocksSight:raw.blocksSight!==false,blocksSound:raw.blocksSound!==false});
 }))});
}

export function createSpatialDestructionService(config={}, {emit=()=>{}}={}){
 const normalized=normalizeConfig(config); const definitions=new Map(normalized.targets.map(v=>[v.id,v]));
 const states=new Map(normalized.targets.map(v=>[v.id,{health:v.initialHealth,destroyed:v.initialHealth<=0}]));
 function definition(id){const found=definitions.get(id);if(!found)throw new Error(`unknown destructible ${id}`);return found;}
 function snapshot(id){const d=definition(id),s=states.get(id);return Object.freeze({...d,health:s.health,destroyed:s.destroyed});}
 function syncConnection(runtime,d,s){
  if(!runtime||!d.connectionId)return;
  try{
   const connection=runtime.location?.connectionsById?.get(d.connectionId); if(!connection)return;
   const current=runtime.getConnectionState(d.connectionId);
   const next=s.destroyed
    ? (connection.states.includes(d.destroyedState)?d.destroyedState:(connection.states.includes("open")?"open":null))
    : (current===d.destroyedState&&connection.states.includes(connection.initialState)?connection.initialState:null);
   if(next&&current!==next)runtime.setConnectionState(d.connectionId,next);
  }catch{}
 }
 return Object.freeze({
  get:snapshot,list(){return Object.freeze([...definitions.keys()].map(snapshot));},
  isBlocking(id,channel="movement"){const d=definition(id),s=states.get(id);if(s.destroyed)return false;if(channel==="sight")return d.blocksSight;if(channel==="sound")return d.blocksSound;return d.blocksMovement;},
  damage(runtime,id,amount,{sourceId=null,kind="generic"}={}){
   const d=definition(id),s=states.get(id); if(s.destroyed)return snapshot(id);
   const damage=Math.max(0,finite(amount,`${id}.damage`,0)); if(!damage)return snapshot(id);
   const before=s.health; s.health=Math.max(0,s.health-damage); s.destroyed=s.health<=0;
   emit("destruction.damage",{targetId:id,before,health:s.health,damage,sourceId,kind});
   if(s.destroyed){syncConnection(runtime,d,s);emit("destruction.destroyed",{targetId:id,connectionId:d.connectionId,sourceId,kind});}
   return snapshot(id);
  },
  repair(runtime,id,amount){const d=definition(id),s=states.get(id);const before=s.health;s.health=Math.min(d.maxHealth,s.health+Math.max(0,finite(amount,`${id}.repair`,0)));s.destroyed=s.health<=0;emit("destruction.repair",{targetId:id,before,health:s.health});return snapshot(id);},
  sync(runtime){for(const [id,d] of definitions){syncConnection(runtime,d,states.get(id));}return this.list();},
  serialize(){return Object.fromEntries([...states].map(([id,s])=>[id,{health:s.health,destroyed:s.destroyed}]));},
  restore(snapshot={}){for(const [id,d] of definitions){const raw=snapshot?.[id];if(!raw)continue;const health=Math.max(0,Math.min(d.maxHealth,finite(raw.health,`${id}.savedHealth`,d.maxHealth)));states.set(id,{health,destroyed:Boolean(raw.destroyed)||health<=0});}},
 });
}

export const SPATIAL_DESTRUCTION_MODULE_TYPE=Object.freeze({id:"spatial.destruction",validateConfig(config){normalizeConfig(config||{});},create(context){return createSpatialDestructionService(context.config||{},{emit:(kind,payload)=>context.emit(kind,payload)});}});
