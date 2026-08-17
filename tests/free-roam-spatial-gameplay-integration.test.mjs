import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {createSpatialFallService} from "../public/src/spatial/spatial-fall-module.js";
import {createSpatialMaterialCatalog} from "../public/src/spatial/spatial-materials-module.js";
import {
  announceFreeRoamSpatialGameplay,
  finishFreeRoamSpatialGameplayStep,
  prepareFreeRoamSpatialGameplayStep,
} from "../public/src/spatial/spatial-free-roam-gameplay.js";

function runtimeFixture() {
  const upper={id:"upper",transform:{position:{x:0,y:0,z:12},yaw:0},parentSpaceId:null,shape:{outer:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}],minZ:0,maxZ:3}};
  const lower={id:"lower",transform:{position:{x:0,y:0,z:0},yaw:0},parentSpaceId:null,shape:{outer:[{x:0,y:0,z:0},{x:20,y:0,z:0},{x:20,y:20,z:0},{x:0,y:20,z:0}],minZ:0,maxZ:20}};
  const fall=createSpatialFallService({drops:[{id:"drop.high",label:"двенадцатиметровый обрыв",fromSpaceId:"upper",toSpaceId:"lower",edge:{axis:"y",side:"max",rangeMin:1,rangeMax:9,approach:1.7},materialId:"concrete"}]});
  const materials=createSpatialMaterialCatalog({defaultMaterial:"concrete"});
  const services=new Map([["fall",fall],["materials",materials]]);
  const entities=new Map([["player.free.1",{id:"player.free.1",kind:"player",label:"Игрок 1",spaceId:"upper",localPosition:{x:5,y:9.4,z:0},mode:"foot",data:{}}]]);
  const runtime={
    revision:0,events:[],dynamicTransforms:new Map(),
    location:{id:"loc",worldTransform:{position:{x:0,y:0,z:0},yaw:0},spaces:[upper,lower],spacesById:new Map([["upper",upper],["lower",lower]]),modulePlans:[
      {instance:{id:"fall",type:"spatial.fall"},disabledReason:null},
      {instance:{id:"materials",type:"spatial.materials"},disabledReason:null},
    ]},
    getModule(id){return services.get(id)||null;},
    getEntity(id){const v=entities.get(id);return v?structuredClone(v):null;},
    removeEntity(id){const removed=entities.delete(id);if(removed)this.revision++;return removed;},
    placeEntity(value){entities.set(value.id,{id:value.id,kind:value.kind,label:value.label,spaceId:value.spaceId,localPosition:{...value.position},mode:value.mode,data:{...value.data}});this.revision++;return this.getEntity(value.id);},
  };
  return runtime;
}

function fixture() {
  const runtime=runtimeFixture();
  const integration={compiled:{id:"loc"},runtime(){return runtime;},persistCalls:0,persist(){this.persistCalls++;}};
  const manager={integrations:[integration],byId:new Map([["loc",integration]])};
  const world={time:0,events:[],players:[{id:0,mode:"foot",x:5,y:9.4,z:12,heading:0,airborne:false,jumpHeight:0,jumpVelocity:0,spatialLocationId:"loc",spatialSpaceId:"upper",spatialFloorZ:12,combat:{health:100,alive:true}}]};
  return {runtime,integration,manager,world};
}

test("free-roam fall changes support but leaves gravity to the existing jump arc",()=>{
  const {runtime,manager,world}=fixture();
  const before=prepareFreeRoamSpatialGameplayStep(world,manager);
  world.players[0].y=10.25;
  finishFreeRoamSpatialGameplayStep(world,manager,before,0.05,{});
  assert.equal(world.players[0].spatialSpaceId,"lower");
  assert.equal(world.players[0].spatialFloorZ,0);
  assert.equal(world.players[0].jumpHeight,12);
  assert.equal(world.players[0].airborne,true);
  assert.equal(runtime.getEntity("player.free.1").spaceId,"lower");
  assert.equal(runtime.getEntity("player.free.1").localPosition.z,12);
  assert.ok(world.events.some(event=>event.type==="location-fall-start"));
  const source=fs.readFileSync(new URL("../public/src/spatial/spatial-free-roam-gameplay.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/jumpVelocity\s*[-+]=/);
  assert.doesNotMatch(source,/15\.5\s*\*/);
});

test("landing damage is handed to the existing combat callback and a high fall can be lethal",()=>{
  const {manager,world}=fixture();
  let before=prepareFreeRoamSpatialGameplayStep(world,manager);
  world.players[0].y=10.25;
  finishFreeRoamSpatialGameplayStep(world,manager,before,0.05,{});

  world.players[0].airborne=true;
  world.players[0].jumpVelocity=-22;
  before=prepareFreeRoamSpatialGameplayStep(world,manager);
  world.players[0].airborne=false;
  world.players[0].jumpHeight=0;
  world.players[0].jumpVelocity=0;
  world.players[0].z=0;
  const calls=[];
  finishFreeRoamSpatialGameplayStep(world,manager,before,0.05,{applyCombatDamage:(...args)=>calls.push(args)});
  assert.equal(calls.length,1);
  assert.ok(calls[0][2]>=100);
  assert.equal(calls[0][4].weapon,"fall");
  assert.equal(calls[0][4].eventType,"fall-damage");
  assert.ok(world.events.some(event=>event.type==="location-fall-land"&&event.severity==="lethal"));
});

test("drop-edge cue is direction-neutral and does not repeat just because heading changed",()=>{
  const {runtime,manager,world}=fixture();
  runtime.removeEntity("player.free.1");
  runtime.placeEntity({id:"player.free.1",kind:"player",label:"Игрок 1",spaceId:"upper",position:{x:5,y:9.2,z:0},mode:"foot",data:{}});
  world.players[0].x=5;world.players[0].y=9.2;world.players[0].heading=0;
  announceFreeRoamSpatialGameplay(world,manager);
  const cue=world.events.find(event=>event.type==="location-fall-edge");
  assert.ok(cue);
  assert.doesNotMatch(cue.text,/прямо|слева|справа|позади/);
  assert.equal(Object.hasOwn(cue,"direction"),false);
  const count=world.events.filter(event=>event.type==="location-fall-edge").length;
  world.players[0].heading=180;
  announceFreeRoamSpatialGameplay(world,manager);
  assert.equal(world.events.filter(event=>event.type==="location-fall-edge").length,count);
});

test("core calls fall adapter after legacy physics and before spatial boundary reconciliation",()=>{
  const source=fs.readFileSync(new URL("../public/src/free-roam-core-v8.js",import.meta.url),"utf8");
  const baseStep=source.indexOf("base.stepFreeWorld(world, safeDt)");
  const finish=source.indexOf("finishFreeRoamSpatialGameplayStep(world, spatialIntegration");
  const sync=source.indexOf("spatialIntegration.sync(world");
  assert.ok(baseStep>=0&&finish>baseStep&&sync>finish);
  assert.match(source,/\{applyCombatDamage\}/);
});

test("acceptance lab exposes both fall heights and the accessible 13 metre portal",()=>{
  const location=fs.readFileSync(new URL("../public/src/locations/spatial-lab/location.js",import.meta.url),"utf8");
  const registry=fs.readFileSync(new URL("../public/src/locations/free-roam-location-registry.js",import.meta.url),"utf8");
  assert.match(location,/lab\.drop\.upper/);
  assert.match(location,/lab\.drop\.high/);
  assert.match(location,/z:\s*12/);
  assert.match(location,/type:\s*"spatial\.water"/);
  assert.match(location,/type:\s*"spatial\.destruction"/);
  assert.match(location,/type:\s*"spatial\.actors"/);
  assert.match(location,/type:\s*"spatial\.items"/);
  assert.match(location,/type:\s*"spatial\.quests"/);
  assert.match(registry,/radius:\s*13/);
});
