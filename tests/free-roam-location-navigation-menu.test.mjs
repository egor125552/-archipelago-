import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {FreeRoamSpatialManager} from "../public/src/spatial/spatial-free-roam-integration.js";
import {spatialLocationIdFromNavigationTargetId, spatialLocationMenuTargets, spatialLocationNavigationTargetId} from "../public/src/spatial/spatial-location-catalog.js";

const rect = (w,h,z=3) => ({outer:[[0,0,0],[w,0,0],[w,h,0],[0,h,0]],minZ:0,maxZ:z});
function definition(id,label,x) {
  return {
    schemaVersion:1,id,label,presentation:{label,description:"test",role:"location"},worldTransform:{position:{x,y:14,z:2},yaw:0},persistence:{version:1},
    spaces:[{id:`${id}.yard`,label:"Двор",presentation:{label:"Двор",description:"",role:"outdoor"},transform:{position:{x:0,y:0,z:0},yaw:0},shape:rect(20,20,5),anchors:[{id:`${id}.entry`,kind:"spawn",label:"Вход",position:[2,2,0]}],objects:[]}],
    connections:[],spawns:[{id:`${id}.spawn`,spaceId:`${id}.yard`,anchorId:`${id}.entry`,mode:"foot"}],
    modules:[{id:`${id}.navigation`,type:"spatial.navigation",config:{}},{id:`${id}.accessibility`,type:"spatial.accessibility",config:{}},{id:`${id}.lifecycle`,type:"spatial.lifecycle",config:{}},{id:`${id}.replication`,type:"spatial.replication",config:{}},{id:`${id}.persistence`,type:"spatial.persistence",config:{}}],
  };
}
function world() {
  return {time:0,players:[{id:0,mode:"foot",activeBoat:null,x:200,y:55,heading:0,jumpHeight:0,airborne:false},{id:1,mode:"foot",activeBoat:null,x:205,y:55,heading:0,jumpHeight:0,airborne:false}],boats:[{id:0,owner:0,driver:0,x:200,y:100,heading:0,speed:0,rudder:0}],events:[],freeActivities:{presence:[true,true]},freeScenario:{phase:"salvage",targets:[null,null],guideEnabled:[false,false],sonarCooldown:[0,0],beaconUntil:[0,0]},freeContracts:{encounterActive:false}};
}

test("location navigation ids are generic and reversible",()=>{
 const id="location.any.future"; assert.equal(spatialLocationIdFromNavigationTargetId(spatialLocationNavigationTargetId(id)),id);
});

test("submenu maps every server-registered location, not a lab constant",()=>{
 const result=spatialLocationMenuTargets([{id:"location.a",label:"А"},{id:"location.b",label:"Б"}]);
 assert.deepEqual(result.map(x=>x.label),["А","Б"]);
 assert.deepEqual(result.map(x=>x.navigationTargetId),["location:location.a","location:location.b"]);
});

test("manager publishes all registered locations and ordinary sonar follows selected second location",()=>{
 const one=definition("location.one","Первая",120); const two=definition("location.two","Вторая",250);
 const manager=new FreeRoamSpatialManager({locations:[{definition:one,portal:{position:{x:120,y:55,z:0},spawnId:"location.one.spawn",exitAnchorId:"location.one.entry"}},{definition:two,portal:{position:{x:250,y:55,z:0},spawnId:"location.two.spawn",exitAnchorId:"location.two.entry"}}]});
 const w=world(); manager.initialize(w);
 assert.deepEqual(w.spatialLocationCatalog.map(x=>x.label),["Первая","Вторая"]);
 const input=manager.prepareInput(w,0,{navigationTargetId:"location:location.two",sonar:true,action:false,guide:false});
 assert.equal(input.sonar,false);
 assert.equal(w.freeScenario.targets[0].locationId,"location.two");
 assert.equal(w.freeScenario.targets[0].x,250);
 assert.match(w.events.at(-1).text,/Вторая/);
});

test("existing jump remains source of true height inside a registered location",()=>{
 const def=definition("location.jump","Прыжковая",180);
 const manager=new FreeRoamSpatialManager({locations:[{definition:def,portal:{position:{x:180,y:55,z:0},radius:5,spawnId:"location.jump.spawn",exitAnchorId:"location.jump.entry"}}]});
 const w=world(); w.players[0].x=180; manager.initialize(w);
 manager.prepareInput(w,0,{action:true,sonar:false,guide:false,navigationTargetId:"objective"});
 assert.equal(w.players[0].spatialLocationId,"location.jump");
 w.players[0].jumpHeight=1.35; w.players[0].airborne=true; manager.sync(w);
 assert.equal(Math.round(w.players[0].z*100)/100,3.35);
});

test("target menu contains one generic locations submenu and does not hardcode the lab",()=>{
 const source=fs.readFileSync(new URL("../public/src/free-roam-target-menu.js",import.meta.url),"utf8");
 assert.match(source,/submenu:\s*"locations"/);
 assert.match(source,/spatialLocationMenuTargets/);
 assert.doesNotMatch(source,/Пространственная лаборатория/);
});

test("client prediction source respects spatial bounds and authoritative space changes",()=>{
 const source=fs.readFileSync(new URL("../public/src/free-roam-client-prediction.js",import.meta.url),"utf8");
 assert.match(source,/spatialAuthorityChanged/);
 assert.match(source,/spatialBounds\.minX/);
 assert.match(source,/spatialBounds\.maxY/);
});

test("server accepts generic location navigation ids instead of normalizing them back to objective",()=>{
 const source=fs.readFileSync(new URL("../src/free-roam-server.js",import.meta.url),"utf8");
 assert.match(source,/targetId\.startsWith\("location:"\)/);
});
