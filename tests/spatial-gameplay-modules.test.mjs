import test from "node:test";
import assert from "node:assert/strict";

import {createSpatialMaterialCatalog} from "../public/src/spatial/spatial-materials-module.js";
import {createSpatialWaterService} from "../public/src/spatial/spatial-water-module.js";
import {createSpatialDestructionService} from "../public/src/spatial/spatial-destruction-module.js";
import {createSpatialActorService} from "../public/src/spatial/spatial-actor-module.js";
import {createSpatialCombatService} from "../public/src/spatial/spatial-combat-module.js";
import {createSpatialItemsService} from "../public/src/spatial/spatial-items-module.js";
import {createSpatialQuestService} from "../public/src/spatial/spatial-quest-module.js";
import {createSpatialFallService,computeSpatialFallDamage} from "../public/src/spatial/spatial-fall-module.js";

function fakeRuntime(){
 const entities=new Map();
 const connection={id:"door",states:["open","closed","destroyed"],initialState:"closed"};
 const states=new Map([["door","closed"]]);
 const rect={outer:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}],minZ:0,maxZ:20};
 const lowerRect={outer:[{x:0,y:0,z:0},{x:20,y:0,z:0},{x:20,y:20,z:0},{x:0,y:20,z:0}],minZ:0,maxZ:20};
 const spaces=[
  {id:"upper",transform:{position:{x:0,y:0,z:10},yaw:0},parentSpaceId:null,shape:rect},
  {id:"lower",transform:{position:{x:0,y:0,z:0},yaw:0},parentSpaceId:null,shape:lowerRect},
  {id:"moving",transform:{position:{x:30,y:10,z:3},yaw:0},parentSpaceId:null,shape:rect,moving:true},
 ];
 const runtime={
  location:{worldTransform:{position:{x:0,y:0,z:0},yaw:0},spaces,spacesById:new Map(spaces.map(v=>[v.id,v])),connectionsById:new Map([["door",connection]])},
  dynamicTransforms:new Map(),
  getEntity(id){const e=entities.get(id);return e?structuredClone(e):null;},
  placeEntity(e){entities.set(e.id,{id:e.id,kind:e.kind,label:e.label,spaceId:e.spaceId,localPosition:{...e.position},mode:e.mode,data:{...e.data}});return this.getEntity(e.id);},
  removeEntity(id){return entities.delete(id);},
  getConnectionState(id){return states.get(id);},
  setConnectionState(id,state){states.set(id,state);return true;},
 };
 return runtime;
}

test("materials change effective fall speed by surface",()=>{
 const materials=createSpatialMaterialCatalog({defaultMaterial:"concrete"});
 const concrete=materials.impact({speed:15,materialId:"concrete"});
 const sand=materials.impact({speed:15,materialId:"sand"});
 const water=materials.impact({speed:15,materialId:"water",waterDepth:3});
 assert.ok(concrete.effectiveSpeed>sand.effectiveSpeed);
 assert.ok(sand.effectiveSpeed>water.effectiveSpeed);
});

test("water source fills and pump drains the same declared volume",()=>{
 const water=createSpatialWaterService({volumes:[{id:"room",spaceId:"lower",area:10,maxDepth:2}],sources:[{id:"leak",volumeId:"room",rate:1}],pumps:[{id:"pump",volumeId:"room",rate:2,enabled:false}]});
 water.tick(5); assert.equal(water.get("room").depth,0.5);
 water.setPumpEnabled("pump",true); water.tick(2); assert.equal(water.get("room").depth,0.3);
 const saved=water.serialize(); water.setDepth("room",0); water.restore(saved); assert.equal(water.get("room").depth,0.3);
});

test("destroying a barrier changes the shared connection state",()=>{
 const runtime=fakeRuntime();
 const destruction=createSpatialDestructionService({targets:[{id:"wall",connectionId:"door",maxHealth:20}]});
 assert.equal(destruction.isBlocking("wall","sight"),true);
 destruction.damage(runtime,"wall",20);
 assert.equal(runtime.getConnectionState("door"),"destroyed");
 assert.equal(destruction.isBlocking("wall","movement"),false);
 destruction.repair(runtime,"wall",20); destruction.sync(runtime);
 assert.equal(runtime.getConnectionState("door"),"closed");
 assert.equal(destruction.isBlocking("wall","movement"),true);
});

test("actor foundation places one authoritative entity and removes it on death",()=>{
 const runtime=fakeRuntime();
 const actors=createSpatialActorService({actors:[{id:"dummy",label:"Манекен",spaceId:"lower",position:[5,5,0],maxHealth:30,hostile:true}]});
 actors.spawn(runtime,"dummy"); assert.ok(runtime.getEntity("actor.dummy"));
 actors.damage(runtime,"dummy",30,{sourceId:"player"});
 assert.equal(actors.get("dummy").alive,false); assert.equal(runtime.getEntity("actor.dummy"),null);
});

test("spatial combat rejects other spaces and respects destructible line-of-fire blockers",()=>{
 const runtime=fakeRuntime();
 runtime.placeEntity({id:"a",kind:"player",label:"A",spaceId:"lower",position:{x:1,y:5,z:1},mode:"foot",data:{}});
 runtime.placeEntity({id:"b",kind:"actor",label:"B",spaceId:"lower",position:{x:9,y:5,z:1},mode:"foot",data:{actorId:"dummy"}});
 const destruction=createSpatialDestructionService({targets:[{id:"wall",maxHealth:5}]});
 const combat=createSpatialCombatService({barriers:[{id:"barrier",spaceId:"lower",center:[5,5,1],radius:0.6,destructibleId:"wall"}]});
 assert.equal(combat.trace(runtime,{attackerId:"a",targetId:"b",destruction}).reason,"blocked");
 destruction.damage(runtime,"wall",5); assert.equal(combat.trace(runtime,{attackerId:"a",targetId:"b",destruction}).clear,true);
 runtime.removeEntity("b");runtime.placeEntity({id:"b",kind:"actor",label:"B",spaceId:"upper",position:{x:5,y:5,z:1},mode:"foot",data:{actorId:"dummy"}});
 assert.equal(combat.trace(runtime,{attackerId:"a",targetId:"b",destruction}).reason,"different-space");
});

test("portable item has one state across world, held, container, and moving space",()=>{
 const runtime=fakeRuntime();
 const items=createSpatialItemsService({items:[{id:"crate",label:"Ящик",spaceId:"lower",position:[2,2,0]}]});
 items.spawn(runtime,"crate");assert.ok(runtime.getEntity("item.crate"));
 items.pickup(runtime,"crate","player.1");assert.equal(runtime.getEntity("item.crate"),null);assert.equal(items.get("crate").state,"held");
 items.store(runtime,"crate","locker");assert.equal(items.get("crate").containerId,"locker");
 items.drop(runtime,"crate",{spaceId:"lower",position:[3,3,0]});assert.ok(runtime.getEntity("item.crate"));
 items.pickup(runtime,"crate","player.1");
 items.drop(runtime,"crate",{spaceId:"moving",position:[4,2,0]});
 const moving=runtime.getEntity("item.crate");
 assert.equal(moving.spaceId,"moving");
 assert.deepEqual(moving.localPosition,{x:4,y:2,z:0});
 assert.equal(items.get("crate").state,"world");
});

test("quest state advances from stable event ids and persists",()=>{
 const quests=createSpatialQuestService({quests:[{id:"quest.test",label:"Тест",objectives:[{id:"break",eventKind:"destruction.destroyed",match:{targetId:"wall"}},{id:"kill",eventKind:"actor.death",match:{actorId:"dummy"}}]}]});
 quests.ingest({kind:"destruction.destroyed",payload:{targetId:"wall"}});assert.equal(quests.get("quest.test").state,"active");
 quests.ingest({kind:"actor.death",payload:{actorId:"dummy"}});assert.equal(quests.get("quest.test").state,"completed");
 const saved=quests.serialize();const restored=createSpatialQuestService({quests:[{id:"quest.test",objectives:[{id:"break",eventKind:"destruction.destroyed",match:{targetId:"wall"}},{id:"kill",eventKind:"actor.death",match:{actorId:"dummy"}}]}]});restored.restore(saved);assert.equal(restored.get("quest.test").state,"completed");
});

test("fall service transfers support without integrating a second gravity loop",()=>{
 const runtime=fakeRuntime();
 runtime.placeEntity({id:"p",kind:"player",label:"P",spaceId:"upper",position:{x:5,y:9.7,z:0},mode:"foot",data:{}});
 const falls=createSpatialFallService({drops:[{id:"edge",fromSpaceId:"upper",toSpaceId:"lower",edge:{axis:"y",side:"max",rangeMin:2,rangeMax:8,approach:1},materialId:"concrete"}]});
 const crossing=falls.findCrossing(runtime,{entityId:"p",worldPosition:{x:5,y:10.2,z:10}});
 assert.ok(crossing);assert.equal(crossing.targetFloorZ,0);assert.equal(crossing.targetLocal.z,10);
 falls.begin(runtime,"p",crossing);assert.equal(runtime.getEntity("p").spaceId,"lower");assert.equal(runtime.getEntity("p").localPosition.z,10);
});

test("fall damage is safe at low speed and lethal at sufficiently high concrete speed",()=>{
 assert.equal(computeSpatialFallDamage({impactSpeed:5}).damage,0);
 const materials=createSpatialMaterialCatalog();
 const impact=materials.impact({speed:22,materialId:"concrete"});
 assert.ok(computeSpatialFallDamage({impactSpeed:22,materialImpact:impact}).damage>=100);
});
