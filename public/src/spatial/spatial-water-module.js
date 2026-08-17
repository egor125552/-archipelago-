"use strict";

const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
function finite(value, field, fallback=null) {
  if (value == null && fallback != null) return fallback;
  const number=Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return number;
}
function id(value,field) {
  const result=String(value||"").trim();
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}
function object(value,field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function normalizeConfig(value={}) {
  const config=object(value,"water config");
  const volumes=(config.volumes||[]).map((entry,index)=>{
    const v=object(entry,`water.volumes[${index}]`);
    const maxDepth=Math.max(0,finite(v.maxDepth,`${v.id}.maxDepth`,3));
    const initialDepth=clamp(finite(v.initialDepth,`${v.id}.initialDepth`,0),0,maxDepth);
    return Object.freeze({
      id:id(v.id,`water.volumes[${index}].id`),
      spaceId:id(v.spaceId,`${v.id}.spaceId`),
      area:Math.max(0.1,finite(v.area,`${v.id}.area`,25)),
      maxDepth,
      initialDepth,
      surfaceOffset:finite(v.surfaceOffset,`${v.id}.surfaceOffset`,0),
      materialId:String(v.materialId||"water"),
    });
  });
  const volumeIds=new Set(volumes.map(v=>v.id));
  const normalizeFlow=(entry,index,kind)=>{
    const v=object(entry,`water.${kind}[${index}]`);
    const volumeId=id(v.volumeId,`${kind}.${index}.volumeId`);
    if (!volumeIds.has(volumeId)) throw new Error(`${kind} references unknown water volume ${volumeId}`);
    return Object.freeze({id:id(v.id,`${kind}.${index}.id`),volumeId,rate:Math.max(0,finite(v.rate,`${v.id}.rate`,0)),enabled:v.enabled!==false});
  };
  return Object.freeze({
    volumes:Object.freeze(volumes),
    sources:Object.freeze((config.sources||[]).map((v,i)=>normalizeFlow(v,i,"sources"))),
    pumps:Object.freeze((config.pumps||[]).map((v,i)=>normalizeFlow(v,i,"pumps"))),
  });
}

export function createSpatialWaterService(config={}, {emit=()=>{}}={}) {
  const normalized=normalizeConfig(config);
  const depth=new Map(normalized.volumes.map(v=>[v.id,v.initialDepth]));
  const sources=new Map(normalized.sources.map(v=>[v.id,v.enabled]));
  const pumps=new Map(normalized.pumps.map(v=>[v.id,v.enabled]));
  const volumeById=new Map(normalized.volumes.map(v=>[v.id,v]));

  function getVolume(volumeId) {
    const volume=volumeById.get(volumeId);
    if (!volume) throw new Error(`unknown water volume ${volumeId}`);
    return volume;
  }
  function setEnabled(map, list, flowId, enabled) {
    if (!list.some(v=>v.id===flowId)) throw new Error(`unknown water flow ${flowId}`);
    map.set(flowId,Boolean(enabled));
    emit("water.flow",{flowId,enabled:Boolean(enabled)});
    return Boolean(enabled);
  }
  function setDepth(volumeId,value) {
    const volume=getVolume(volumeId);
    const next=clamp(finite(value,`${volumeId}.depth`),0,volume.maxDepth);
    depth.set(volumeId,next);
    emit("water.depth",{volumeId,depth:next});
    return next;
  }

  return Object.freeze({
    tick(dt) {
      const seconds=Math.max(0,finite(dt,"dt",0));
      if (!seconds) return Object.freeze([]);
      const changed=[];
      for (const volume of normalized.volumes) {
        let cubicMetresPerSecond=0;
        for (const source of normalized.sources) if (source.volumeId===volume.id && sources.get(source.id)) cubicMetresPerSecond+=source.rate;
        for (const pump of normalized.pumps) if (pump.volumeId===volume.id && pumps.get(pump.id)) cubicMetresPerSecond-=pump.rate;
        if (!cubicMetresPerSecond) continue;
        const before=depth.get(volume.id)||0;
        const after=clamp(before + cubicMetresPerSecond/volume.area*seconds,0,volume.maxDepth);
        if (Math.abs(after-before)<1e-9) continue;
        depth.set(volume.id,after);
        const entry=Object.freeze({volumeId:volume.id,before,depth:after});
        changed.push(entry);
        emit("water.depth",entry);
      }
      return Object.freeze(changed);
    },
    get(volumeId) { const volume=getVolume(volumeId); return Object.freeze({...volume,depth:depth.get(volumeId)||0}); },
    list() { return Object.freeze(normalized.volumes.map(v=>Object.freeze({...v,depth:depth.get(v.id)||0}))); },
    sample({spaceId=null,volumeId=null}={}) {
      const found=normalized.volumes.find(v=>(!volumeId||v.id===volumeId)&&(!spaceId||v.spaceId===spaceId)&&(depth.get(v.id)||0)>0);
      return found ? Object.freeze({...found,depth:depth.get(found.id)||0}) : null;
    },
    setDepth,
    setSourceEnabled(flowId,enabled) { return setEnabled(sources,normalized.sources,flowId,enabled); },
    setPumpEnabled(flowId,enabled) { return setEnabled(pumps,normalized.pumps,flowId,enabled); },
    serialize() { return {depth:Object.fromEntries(depth),sources:Object.fromEntries(sources),pumps:Object.fromEntries(pumps)}; },
    restore(snapshot={}) {
      for (const volume of normalized.volumes) if (snapshot.depth && Object.hasOwn(snapshot.depth,volume.id)) setDepth(volume.id,snapshot.depth[volume.id]);
      for (const source of normalized.sources) if (snapshot.sources && Object.hasOwn(snapshot.sources,source.id)) sources.set(source.id,Boolean(snapshot.sources[source.id]));
      for (const pump of normalized.pumps) if (snapshot.pumps && Object.hasOwn(snapshot.pumps,pump.id)) pumps.set(pump.id,Boolean(snapshot.pumps[pump.id]));
    },
  });
}

export const SPATIAL_WATER_MODULE_TYPE=Object.freeze({
  id:"spatial.water",
  validateConfig(config){ normalizeConfig(config||{}); },
  create(context){ return createSpatialWaterService(context.config||{},{emit:(kind,payload)=>context.emit(kind,payload)}); },
});
