"use strict";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const damping=value=>value?clamp(value.acousticDamping,0,1):0;

export function applySpatialAcousticEnvironment(model,{sourceMaterial=null,listenerMaterial=null,sourceWaterDepth=0,listenerWaterDepth=0}={}){
  if(!model||typeof model!=="object")throw new TypeError("spatial acoustic model is required");
  const materialDamping=clamp((damping(sourceMaterial)+damping(listenerMaterial))/2,0,1);
  const waterDepth=Math.max(0,Number(sourceWaterDepth)||0,Number(listenerWaterDepth)||0);
  const waterDamping=waterDepth>0?clamp(0.14+Math.log1p(waterDepth)*0.24,0,0.7):0;
  const gainScale=clamp(1-materialDamping*0.24-waterDamping*0.42,0.18,1);
  const lowpassScale=clamp(1-materialDamping*0.32-waterDamping*0.68,0.08,1);
  return Object.freeze({
    gain:clamp((Number(model.gain)||0)*gainScale,0,1),
    lowpassHz:Math.max(120,(Number(model.lowpassHz)||20000)*lowpassScale),
    reverb:clamp((Number(model.reverb)||0)*(1-materialDamping*0.38+waterDamping*0.08),0,1),
    transmission:clamp(model.transmission??1,0,1),
    environment:Object.freeze({materialDamping,waterDepth,waterDamping,gainScale,lowpassScale}),
  });
}
