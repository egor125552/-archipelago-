import test from "node:test";
import assert from "node:assert/strict";

import {FreeRoamSpatialManager} from "../public/src/spatial/spatial-free-roam-integration.js";

const rect=(w,h,z=3)=>({outer:[[0,0,0],[w,0,0],[w,h,0],[0,h,0]],minZ:0,maxZ:z});

function definition(){
  return {
    schemaVersion:1,
    id:"location.speech.test",
    label:"Тестовая башня",
    presentation:{label:"Тестовая башня",description:"test",role:"location"},
    worldTransform:{position:{x:100,y:50,z:0},yaw:0},
    persistence:{version:1},
    spaces:[
      {id:"floor.low",label:"Первый этаж",presentation:{label:"Первый этаж",description:"",role:"indoor"},transform:{position:{x:0,y:0,z:0},yaw:0},shape:rect(20,20),anchors:[{id:"entry",kind:"spawn",label:"Вход",position:[2,2,0]},{id:"stairs.low",kind:"transition",label:"Лестница",position:[10,10,0]}],objects:[]},
      {id:"floor.high",label:"Второй этаж",presentation:{label:"Второй этаж",description:"",role:"indoor"},transform:{position:{x:0,y:0,z:6},yaw:0},shape:rect(20,20),anchors:[{id:"stairs.high",kind:"transition",label:"Лестница",position:[10,10,0]}],objects:[]},
    ],
    connections:[{
      id:"stairs",label:"Лестница на второй этаж",presentation:{label:"Лестница на второй этаж",description:"",role:"transition"},kind:"stairs",
      from:{spaceId:"floor.low",position:[10,10,0],fallbackAnchorId:"stairs.low"},to:{spaceId:"floor.high",position:[10,10,0],fallbackAnchorId:"stairs.high"},
      initialState:"open",traversal:{mode:"instant",interactionRange:2.8},interactionRange:2.8,discoverRadius:15,cost:1,
    }],
    spawns:[{id:"spawn",spaceId:"floor.low",anchorId:"entry",mode:"foot"}],
    modules:[
      {id:"navigation",type:"spatial.navigation",config:{}},
      {id:"accessibility",type:"spatial.accessibility",config:{}},
      {id:"lifecycle",type:"spatial.lifecycle",config:{}},
      {id:"replication",type:"spatial.replication",config:{}},
      {id:"persistence",type:"spatial.persistence",config:{}},
    ],
  };
}

function world(){
  return {time:0,players:[{id:0,mode:"foot",activeBoat:null,x:100,y:50,heading:180,jumpHeight:0,jumpVelocity:0,airborne:false}],events:[],freeActivities:{presence:[true]},freeScenario:{phase:"salvage",targets:[null],guideEnabled:[false],sonarCooldown:[0],beaconUntil:[0]},freeContracts:{encounterActive:false}};
}

function manager(def=definition()){
  return new FreeRoamSpatialManager({locations:[{definition:def,portal:{position:{x:100,y:50,z:0},radius:6,exitRadius:2,discoverRadius:30,spawnId:"spawn",exitAnchorId:"entry",outsideLabel:"берег"}}]});
}

test("location sonar reports a reliable distance without claiming left right ahead or behind",()=>{
  const m=manager();const w=world();m.initialize(w);
  const input=m.prepareInput(w,0,{navigationTargetId:"location:location.speech.test",sonar:true,guide:false,action:false});
  assert.equal(input.sonar,false);
  const event=w.events.at(-1);
  assert.equal(event.type,"scenario-sonar");
  assert.match(event.text,/Тестовая башня/);
  assert.doesNotMatch(event.text,/прямо|слева|справа|позади/);
});

test("spatial location owns action and never leaks a too-far stair press to legacy boat actions",()=>{
  const m=manager();const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  assert.equal(w.players[0].spatialLocationId,"location.speech.test");
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=105;w.players[0].y=55;
  m.sync(w);
  const input=m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  assert.equal(input.action,false);
  assert.equal(w.events.at(-1).type,"location-action-too-far");
  assert.match(w.events.at(-1).text,/Подойди ближе/);
});

test("ready stair cue says what action will do instead of giving an unreliable direction",()=>{
  const m=manager();const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=110;w.players[0].y=60;
  m.sync(w);
  const event=[...w.events].reverse().find(item=>item.type==="location-nearby"&&item.semanticId==="stairs");
  assert.ok(event);
  assert.match(event.text,/Нажми действие, чтобы подняться\. Следующий уровень: Второй этаж\./);
  assert.doesNotMatch(event.text,/прямо|слева|справа|позади/);
});

test("ordinary object cue does not repeat when crossing two metres",()=>{
  const def=definition();
  def.spaces[0].objects.push({id:"locker",kind:"storage",label:"Шкаф",presentation:{label:"Шкаф",description:"Снаряжение"},position:[19,4,0],userFacing:true});
  const m=manager(def);const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=119;w.players[0].y=51;
  m.sync(w);
  const first=w.events.filter(item=>item.type==="location-nearby"&&item.semanticId==="locker").length;
  assert.equal(first,1);
  w.players[0].x=119;w.players[0].y=52.5;
  m.sync(w);
  const second=w.events.filter(item=>item.type==="location-nearby"&&item.semanticId==="locker").length;
  assert.equal(second,1);
});

test("exit cue holds through a small six metre boundary wobble",()=>{
  const m=manager();const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=107.9;w.players[0].y=52;
  m.sync(w);
  const first=w.events.filter(item=>item.type==="location-nearby").length;
  w.players[0].x=108.2;w.players[0].y=52;
  m.sync(w);
  w.players[0].x=107.9;w.players[0].y=52;
  m.sync(w);
  assert.equal(w.events.filter(item=>item.type==="location-nearby").length,first);
});

test("stair ready cue uses hysteresis instead of flipping on one small step",()=>{
  const m=manager();const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=110;w.players[0].y=57;
  m.sync(w);
  w.players[0].x=110;w.players[0].y=57.3;
  m.sync(w);
  const readyCount=w.events.filter(item=>item.type==="location-nearby"&&item.semanticId==="stairs").length;
  assert.equal(readyCount,2);
  w.players[0].x=110;w.players[0].y=57.1;
  m.sync(w);
  assert.equal(w.events.filter(item=>item.type==="location-nearby"&&item.semanticId==="stairs").length,readyCount);
  w.players[0].x=110;w.players[0].y=56.3;
  m.sync(w);
  assert.equal(w.events.filter(item=>item.type==="location-nearby"&&item.semanticId==="stairs").length,readyCount+1);
});

test("announced object stays focused when a farther stair only barely enters range",()=>{
  const def=definition();
  def.spaces[0].objects.push({id:"locker",kind:"storage",label:"Шкаф",presentation:{label:"Шкаф",description:"Снаряжение"},position:[19,4,0],userFacing:true});
  const m=manager(def);const w=world();m.initialize(w);
  m.prepareInput(w,0,{action:true,sonar:false,guide:false});
  m.prepareInput(w,0,{action:false,sonar:false,guide:false});
  w.players[0].x=119;w.players[0].y=51;
  m.sync(w);
  const first=w.events.filter(item=>item.type==="location-nearby").length;
  w.players[0].x=117;w.players[0].y=53;
  m.sync(w);
  assert.equal(w.events.filter(item=>item.type==="location-nearby").length,first);
  w.players[0].x=113;w.players[0].y=57;
  m.sync(w);
  const latest=[...w.events].reverse().find(item=>item.type==="location-nearby");
  assert.equal(latest.semanticId,"stairs");
});
