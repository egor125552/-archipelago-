import test from "node:test";
import assert from "node:assert/strict";

import {COAST_RESCUE_CENTER_LOCATION,createCoastRescueCenter} from "../public/src/locations/coast-rescue-center/location.js";
import {createSpatialFallService,computeSpatialFallDamage} from "../public/src/spatial/spatial-fall-module.js";

const ROUTE_LEVELS=["rescue.basement","rescue.ground","rescue.second","rescue.roof"];

test("rescue center uses true tall levels and shared navigation",()=>{
 const {compiled,runtime}=createCoastRescueCenter();
 for(const id of ["rescue.exterior",...ROUTE_LEVELS])assert.ok(compiled.spacesById.has(id));
 runtime.spawnEntity({id:"player.rescue",spawnId:"rescue.spawn.entry"});
 assert.equal(runtime.getEntityWorldPosition("player.rescue").z,0);
 runtime.transitionEntity("player.rescue","rescue.connection.ground-second");
 assert.equal(runtime.getEntityWorldPosition("player.rescue").z,10);
 runtime.transitionEntity("player.rescue","rescue.connection.second-roof");
 assert.equal(runtime.getEntityWorldPosition("player.rescue").z,22);
 const route=runtime.getModule("rescue.navigation").findRoute({fromSpaceId:"rescue.basement",toSpaceId:"rescue.roof"});
 assert.deepEqual(route.spaces,ROUTE_LEVELS);
});

test("all four exposed edges are generated for the upper gallery and roof",()=>{
 const {runtime}=createCoastRescueCenter();const fall=runtime.getModule("rescue.fall");
 const second=fall.list().filter(drop=>drop.fromSpaceId==="rescue.second");
 const roof=fall.list().filter(drop=>drop.fromSpaceId==="rescue.roof");
 assert.equal(second.length,4);assert.equal(roof.length,4);
 assert.deepEqual(new Set(roof.map(drop=>`${drop.edge.axis}:${drop.edge.side}`)),new Set(["x:min","x:max","y:min","y:max"]));
 assert.ok([...second,...roof].every(drop=>drop.toSpaceId==="rescue.exterior"));
});

test("roof edge starts a real 22 metre fall into exterior landing space",()=>{
 const {runtime}=createCoastRescueCenter();runtime.spawnEntity({id:"player.rescue",spawnId:"rescue.spawn.entry"});runtime.transitionEntity("player.rescue","rescue.connection.ground-second");runtime.transitionEntity("player.rescue","rescue.connection.second-roof");
 const entity=runtime.getEntity("player.rescue");runtime.moveEntity("player.rescue",{x:17.7,y:7,z:0});
 const fall=runtime.getModule("rescue.fall");const crossing=fall.findCrossing(runtime,{entityId:"player.rescue",worldPosition:{x:148.2,y:19,z:22}});
 assert.ok(crossing);assert.equal(crossing.fromSpaceId,"rescue.roof");assert.equal(crossing.toSpaceId,"rescue.exterior");assert.equal(crossing.targetFloorZ,0);
 fall.begin(runtime,"player.rescue",crossing);assert.equal(runtime.getEntity("player.rescue").spaceId,"rescue.exterior");
});

test("a 22 metre concrete fall is lethal in the shared damage model",()=>{
 const impactSpeed=Math.sqrt(2*15.5*22);const result=computeSpatialFallDamage({impactSpeed,materialImpact:{effectiveSpeed:impactSpeed*Math.sqrt(0.94)}});
 assert.equal(result.severity,"lethal");assert.ok(result.damage>=100);
});

test("automatic edges are opt-in and do not turn ordinary closed rooms into cliffs",()=>{
 const fall=createSpatialFallService({autoEdges:[]},{spaces:COAST_RESCUE_CENTER_LOCATION.spaces});assert.equal(fall.list().length,0);
});
