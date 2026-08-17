"use strict";

function point(value={}){const p={x:Number(value.x??value[0]??0),y:Number(value.y??value[1]??0),z:Number(value.z??value[2]??0)};if(!Object.values(p).every(Number.isFinite))throw new TypeError("item position must be finite");return p;}
function normalizeConfig(config={}){if(!config||typeof config!=="object"||Array.isArray(config))throw new TypeError("items config must be an object");return Object.freeze({items:Object.freeze((config.items||[]).map((raw,index)=>{if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new TypeError(`items[${index}] must be an object`);const id=String(raw.id||"").trim(),spaceId=String(raw.spaceId||"").trim();if(!id||!spaceId)throw new TypeError(`item ${index} needs id and spaceId`);return Object.freeze({id,label:String(raw.label||id),kind:String(raw.kind||"item"),spaceId,position:Object.freeze(point(raw.position||{})),data:Object.freeze({...raw.data})});}))});}
export function createSpatialItemsService(config={}, {emit=()=>{}}={}){
 const normalized=normalizeConfig(config);const defs=new Map(normalized.items.map(v=>[v.id,v]));const states=new Map(normalized.items.map(v=>[v.id,{state:"world",spaceId:v.spaceId,position:{...v.position},holderId:null,containerId:null}]));const entityId=id=>`item.${id}`;
 function def(id){const found=defs.get(id);if(!found)throw new Error(`unknown item ${id}`);return found;}function get(id){const d=def(id),s=states.get(id);return Object.freeze({...d,...s,position:s.position?Object.freeze({...s.position}):null,entityId:entityId(id)});}
 function remove(runtime,id){runtime?.removeEntity?.(entityId(id));}
 function ensureWorldEntity(runtime,id){const d=def(id),s=states.get(id);if(s.state!=="world")return;if(!runtime.getEntity(entityId(id)))runtime.placeEntity({id:entityId(id),kind:"item",label:d.label,spaceId:s.spaceId,position:s.position,mode:"world",data:{itemId:id,itemKind:d.kind,...d.data}});}
 return Object.freeze({
  get,list(){return Object.freeze([...defs.keys()].map(get));},spawn(runtime,id){ensureWorldEntity(runtime,id);return get(id);},
  pickup(runtime,id,holderId){def(id);const s=states.get(id);remove(runtime,id);Object.assign(s,{state:"held",spaceId:null,position:null,holderId:String(holderId),containerId:null});emit("item.pickup",{itemId:id,holderId:String(holderId)});return get(id);},
  store(runtime,id,containerId){def(id);const s=states.get(id);remove(runtime,id);Object.assign(s,{state:"container",spaceId:null,position:null,holderId:null,containerId:String(containerId)});emit("item.store",{itemId:id,containerId:String(containerId)});return get(id);},
  drop(runtime,id,{spaceId,position}){def(id);const s=states.get(id);remove(runtime,id);Object.assign(s,{state:"world",spaceId:String(spaceId),position:point(position),holderId:null,containerId:null});ensureWorldEntity(runtime,id);emit("item.drop",{itemId:id,spaceId:s.spaceId,position:s.position});return get(id);},
  serialize(){return Object.fromEntries([...states].map(([id,s])=>[id,{...s,position:s.position?{...s.position}:null}]));},
  restore(snapshot={}){for(const [id,d] of defs){const raw=snapshot?.[id];if(!raw)continue;const state=["world","held","container"].includes(raw.state)?raw.state:"world";states.set(id,{state,spaceId:state==="world"?String(raw.spaceId||d.spaceId):null,position:state==="world"?point(raw.position||d.position):null,holderId:state==="held"?String(raw.holderId||""):null,containerId:state==="container"?String(raw.containerId||""):null});}},
 });
}
export const SPATIAL_ITEMS_MODULE_TYPE=Object.freeze({id:"spatial.items",validateConfig(config){normalizeConfig(config||{});},create(context){return createSpatialItemsService(context.config||{},{emit:(kind,payload)=>context.emit(kind,payload)});}});
