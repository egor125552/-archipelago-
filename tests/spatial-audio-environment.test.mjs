import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {applySpatialAcousticEnvironment} from "../public/src/spatial/spatial-acoustic-environment.js";
import {spatialAudioMix} from "../public/src/spatial/spatial-audio-adapter.js";
import {createSpatialMaterialCatalog} from "../public/src/spatial/spatial-materials-module.js";

test("different shared materials produce measurably different models for the existing audio path",()=>{
  const materials=createSpatialMaterialCatalog();
  const base={gain:1,lowpassHz:18000,reverb:0.3,transmission:1};
  const metal=applySpatialAcousticEnvironment(base,{sourceMaterial:materials.get("metal"),listenerMaterial:materials.get("metal")});
  const rubber=applySpatialAcousticEnvironment(base,{sourceMaterial:materials.get("rubber"),listenerMaterial:materials.get("rubber")});
  assert.ok(rubber.gain<metal.gain);
  assert.ok(rubber.lowpassHz<metal.lowpassHz);
  assert.notEqual(spatialAudioMix(metal,{gain:0.2}).dryGain,spatialAudioMix(rubber,{gain:0.2}).dryGain);
});

test("water depth changes the same model without introducing another audio implementation",()=>{
  const base={gain:0.9,lowpassHz:17000,reverb:0.24,transmission:1};
  const dry=applySpatialAcousticEnvironment(base);
  const wet=applySpatialAcousticEnvironment(base,{listenerWaterDepth:1.4});
  assert.ok(wet.gain<dry.gain);
  assert.ok(wet.lowpassHz<dry.lowpassHz);
  assert.ok(wet.environment.waterDamping>0);
  const source=fs.readFileSync(new URL("../public/src/spatial/spatial-acoustic-environment.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/AudioContext|createBiquadFilter|createGain/);
});

test("audible acceptance page reuses one shared AudioEngine and playSpatialTone for metal, rubber and water",()=>{
  const app=fs.readFileSync(new URL("../public/src/spatial/spatial-acoustic-acceptance.js",import.meta.url),"utf8");
  assert.match(app,/new AudioEngine\(\)/);
  assert.equal((app.match(/new AudioEngine\(\)/g)||[]).length,1);
  assert.match(app,/playSpatialTone/);
  assert.match(app,/materials\.get\("metal"\)/);
  assert.match(app,/materials\.get\("rubber"\)/);
  assert.match(app,/listenerWaterDepth:1\.4/);
  assert.doesNotMatch(app,/new AudioContext/);
});
