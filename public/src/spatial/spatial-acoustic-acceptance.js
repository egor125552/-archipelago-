"use strict";

import {AudioEngine} from "../audio-engine-v13.js?free=2";
import {playSpatialTone} from "./spatial-audio-adapter.js";
import {applySpatialAcousticEnvironment} from "./spatial-acoustic-environment.js";
import {createSpatialMaterialCatalog} from "./spatial-materials-module.js";

const status=document.querySelector("#status");
const button=document.querySelector("#play");
const materials=createSpatialMaterialCatalog();
const audio=new AudioEngine();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const base=Object.freeze({gain:0.9,lowpassHz:18000,reverb:0.28,transmission:1});

async function playAcceptance(){
  await audio.init();
  if(!audio.ctx||!audio.master){status.textContent="Аудиодвижок браузера недоступен.";return;}
  const models=[
    ["металл",applySpatialAcousticEnvironment(base,{sourceMaterial:materials.get("metal"),listenerMaterial:materials.get("metal")})],
    ["резина",applySpatialAcousticEnvironment(base,{sourceMaterial:materials.get("rubber"),listenerMaterial:materials.get("rubber")})],
    ["вода 1,4 метра",applySpatialAcousticEnvironment(base,{sourceMaterial:materials.get("concrete"),listenerMaterial:materials.get("concrete"),listenerWaterDepth:1.4})],
  ];
  status.textContent="Сначала металл, затем резина, затем вода. Все три тона идут через один общий AudioEngine и один playSpatialTone.";
  for(const [,model] of models){playSpatialTone(audio,model,{frequency:330,duration:0.5,gain:0.22});await wait(650);}
}
button.addEventListener("click",()=>playAcceptance().catch(error=>{status.textContent=`Ошибка: ${error.message}`;}));
