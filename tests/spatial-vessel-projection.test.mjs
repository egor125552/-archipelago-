import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {projectVesselDefinitionToSpatial,vesselOccupantToSpatialLocal} from "../public/src/vessel/adapters/spatial-vessel-projection.js";

const vessel={
 id:"dual-turret-patrol",label:"двухместный бронекатер",capabilities:{walkableInterior:true},
 deckArchitecture:{boarding:{points:[{id:"entry",deckId:"main",position:[0,-4],safe:true}]}},
 decks:[
  {id:"main",label:"малая палуба",level:0,shape:{outer:[[-4,-6],[4,-6],[4,6],[-4,6]]},landmarks:[{id:"ladder",label:"лестница",position:[0,3]}],objects:[],connections:[{id:"up",reverseId:"down",toDeckId:"bridge",label:"люк",kind:"hatch",from:[0,3],to:[0,-2],initialState:"closed",states:["open","closed","destroyed"],passableStates:["open","destroyed"],traversal:{mode:"geometry",levelHeight:3},acoustics:{openTransmission:.9,closedTransmission:.25}}]},
  {id:"bridge",label:"рубка",level:1,shape:{outer:[[-3,-3],[3,-3],[3,3],[-3,3]]},landmarks:[],objects:[{id:"helm",kind:"station",label:"пульт",position:[0,1]}],connections:[{id:"down",reverseId:"up",toDeckId:"main",label:"люк",kind:"hatch",from:[0,-2],to:[0,3],initialState:"closed",states:["open","closed","destroyed"],passableStates:["open","destroyed"],traversal:{mode:"geometry",levelHeight:3},acoustics:{openTransmission:.9,closedTransmission:.25}}]},
 ],
};

test("existing vessel decks project into one moving spatial root without rewriting vessel config",()=>{
 const original=structuredClone(vessel);
 const projected=projectVesselDefinitionToSpatial(vessel,{instanceId:"vessel:dual:i1"});
 assert.deepEqual(vessel,original);
 const root=projected.spaces.find(space=>space.id==="vessel.root");
 const main=projected.spaces.find(space=>space.id==="vessel.deck.main");
 const bridge=projected.spaces.find(space=>space.id==="vessel.deck.bridge");
 assert.equal(root.moving,true);
 assert.equal(main.parentSpaceId,"vessel.root");
 assert.equal(bridge.transform.position.z,3);
 assert.equal(projected.connections.length,1,"reverse vessel hatch pair becomes one shared bidirectional connection");
 assert.equal(projected.connections[0].bidirectional,true);
 assert.equal(projected.connections[0].traversal.mode,"physical");
});

test("vessel local coordinates are converted once at the adapter boundary",()=>{
 const local=vesselOccupantToSpatialLocal({x:2,y:5});
 assert.deepEqual(local,{x:2,y:-5,z:0});
 // Vessel heading 0 maps local +y toward world -y. The flip makes the
 // standard spatial transform describe the exact same physical point.
 assert.equal(local.y,-5);
});

test("live adapter reuses the shared moving-space adapter and core keeps vessel behavior owner unchanged",()=>{
 const adapter=fs.readFileSync(new URL("../public/src/vessel/adapters/spatial-vessel-adapter.js",import.meta.url),"utf8");
 const core=fs.readFileSync(new URL("../public/src/free-roam-core-v8.js",import.meta.url),"utf8");
 assert.match(adapter,/applyMovingSpaceSample/);
 assert.match(adapter,/dual-turret-patrol/);
 assert.doesNotMatch(adapter,/boat\.speed\s*=/);
 assert.doesNotMatch(adapter,/boat\.heading\s*=/);
 assert.match(core,/syncFreeRoamVesselSpatialMirrors/);
 assert.match(core,/runVesselSystems\("after-step"[\s\S]*syncFreeRoamVesselSpatialMirrors/);
});
