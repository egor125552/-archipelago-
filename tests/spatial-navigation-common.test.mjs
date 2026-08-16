import test from "node:test";
import assert from "node:assert/strict";

import {findSpatialRoute} from "../public/src/spatial/spatial-navigation.js";

function runtimeFixture({connectionState = "open", withConnection = true} = {}) {
  const a = {id:"space.a",label:"Низ",presentation:{label:"Низ"}};
  const b = {id:"space.b",label:"Верх",presentation:{label:"Верх"}};
  const connection = {
    id:"connection.stairs",label:"Лестница",presentation:{label:"Лестница"},kind:"stairs",
    from:{spaceId:a.id,position:{x:8,y:2,z:0}},to:{spaceId:b.id,position:{x:1,y:1,z:0}},
    bidirectional:true,cost:2,passableStates:["open"],
  };
  const location = {
    spaces:[a,b], spacesById:new Map([[a.id,a],[b.id,b]]),
    connections: withConnection ? [connection] : [], connectionsById: withConnection ? new Map([[connection.id,connection]]) : new Map(),
  };
  return {location,getConnectionState(){return connectionState;}};
}

test("common navigation routes between concrete points through declared connection endpoints", () => {
  const runtime = runtimeFixture();
  const route = findSpatialRoute(runtime, {
    fromSpaceId:"space.a", fromPoint:{x:0,y:0,z:0},
    toSpaceId:"space.b", toPoint:{x:4,y:1,z:0},
  });
  assert.deepEqual(route.spaces,["space.a","space.b"]);
  assert.equal(route.steps.length,1);
  assert.equal(route.steps[0].connectionId,"connection.stairs");
  assert.deepEqual(route.waypoints.map(entry=>entry.spaceId),["space.a","space.b","space.b"]);
  assert.ok(route.cost > 2);
});

test("closed live connection removes the route without a second navigation state", () => {
  const route = findSpatialRoute(runtimeFixture({connectionState:"closed"}), {
    fromSpaceId:"space.a",fromPoint:{x:0,y:0,z:0},toSpaceId:"space.b",toPoint:{x:1,y:1,z:0},
  });
  assert.equal(route,null);
});

test("same-space route can use shared detour candidates when direct geometry is blocked", () => {
  const runtime = runtimeFixture({withConnection:false});
  const start={x:0,y:0,z:0};
  const goal={x:10,y:0,z:0};
  const route = findSpatialRoute(runtime, {
    fromSpaceId:"space.a",fromPoint:start,toSpaceId:"space.a",toPoint:goal,
    waypointCandidates(spaceId){ return spaceId === "space.a" ? [{x:5,y:5,z:0}] : []; },
    linePassable(_spaceId,from,to){
      const direct = from.x === 0 && from.y === 0 && to.x === 10 && to.y === 0;
      const reverse = to.x === 0 && to.y === 0 && from.x === 10 && from.y === 0;
      return !(direct || reverse);
    },
  });
  assert.ok(route);
  assert.deepEqual(route.spaces,["space.a"]);
  assert.ok(route.waypoints.some(entry=>entry.kind === "detour"));
});

test("same-space route fails when common geometry says every segment is blocked", () => {
  const route = findSpatialRoute(runtimeFixture({withConnection:false}), {
    fromSpaceId:"space.a",fromPoint:{x:0,y:0,z:0},toSpaceId:"space.a",toPoint:{x:3,y:3,z:0},
    linePassable(){return false;},
  });
  assert.equal(route,null);
});

test("semantic callers remain backward-compatible when no precise points are supplied", () => {
  const route=findSpatialRoute(runtimeFixture(),{fromSpaceId:"space.a",toSpaceId:"space.b"});
  assert.deepEqual(route.spaces,["space.a","space.b"]);
  assert.equal(route.steps[0].label,"Лестница");
});
