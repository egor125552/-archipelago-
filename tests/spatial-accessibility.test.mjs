import test from "node:test";
import assert from "node:assert/strict";

import {
  describeNearbySpatialEntry,
  describeSpatialSemanticContext,
  nearbySpatialSemantics,
  relativeSpatialDirection,
} from "../public/src/spatial/spatial-accessibility.js";

function runtimeFixture() {
  const room = {
    id: "space.room",
    label: "Комната",
    presentation: {label: "Комната", description: "Тестовая комната", role: "indoor"},
    transform: {position: {x: 0, y: 0, z: 2}, yaw: 0},
    shape: {outer: [{x:0,y:0,z:0},{x:20,y:0,z:0},{x:20,y:20,z:0},{x:0,y:20,z:0}], minZ:0, maxZ:5},
    anchors: [
      {id:"anchor.stairs",kind:"transition",label:"Лестница",presentation:{label:"Лестница",description:"Наверх"},position:{x:5,y:0,z:0},navigation:true},
      {id:"anchor.hidden",kind:"technical",label:"Скрыто",presentation:{label:"Скрыто"},position:{x:1,y:1,z:0},navigation:false},
    ],
    objects: [
      {id:"object.generator",kind:"generator",label:"Генератор",presentation:{label:"Генератор",description:"Шумный генератор"},position:{x:0,y:4,z:0},userFacing:true},
      {id:"object.internal",kind:"internal",label:"Внутренний",position:{x:0,y:1,z:0},userFacing:false},
    ],
  };
  const upper = {
    id:"space.upper",label:"Верх",presentation:{label:"Верхний этаж",description:"",role:"indoor"},
    transform:{position:{x:0,y:0,z:5},yaw:0}, shape: room.shape, anchors:[], objects:[],
  };
  const location = {
    id:"location.test",label:"Лаборатория",presentation:{label:"Лаборатория",description:"Общая тестовая локация",role:"location"},
    worldTransform:{position:{x:100,y:50,z:0},yaw:0},
    spaces:[room,upper], spacesById:new Map([[room.id,room],[upper.id,upper]]),
    connections:[{
      id:"connection.up",kind:"stairs",label:"Лестница наверх",presentation:{label:"Лестница наверх",description:"Переход на верхний этаж"},
      from:{spaceId:room.id,position:{x:5,y:0,z:0}},to:{spaceId:upper.id,position:{x:1,y:1,z:0}},bidirectional:true,
      initialState:"open",passableStates:["open"],
    }],
  };
  const entity = {id:"player.one",spaceId:room.id,localPosition:{x:0,y:0,z:0}};
  return {
    location,
    dynamicTransforms:new Map(),
    getEntity(id){ return id === entity.id ? structuredClone(entity) : null; },
    getEntityWorldPosition(id){
      if (id !== entity.id) throw new Error("unknown");
      return {x:100,y:50,z:2};
    },
    getConnectionState(id){ return id === "connection.up" ? "open" : null; },
  };
}

test("semantic context exposes location, space and true elevation without UI wording", () => {
  const context = describeSpatialSemanticContext(runtimeFixture(), "player.one", {maximumDistance:10,heading:0});
  assert.equal(context.location.label, "Лаборатория");
  assert.equal(context.space.label, "Комната");
  assert.equal(context.elevation, 2);
  assert.ok(Array.isArray(context.nearby));
});

test("nearby semantics include transitions, landmarks and user-facing objects from one source", () => {
  const entries = nearbySpatialSemantics(runtimeFixture(), "player.one", {maximumDistance:10,heading:0});
  assert.ok(entries.some(entry => entry.id === "anchor.stairs" && entry.type === "anchor"));
  assert.ok(entries.some(entry => entry.id === "object.generator" && entry.type === "object"));
  assert.ok(entries.some(entry => entry.id === "connection.up" && entry.type === "connection" && entry.destinationLabel === "Верхний этаж"));
  assert.ok(!entries.some(entry => entry.id === "anchor.hidden"));
  assert.ok(!entries.some(entry => entry.id === "object.internal"));
});

test("connection availability follows the live common connection state", () => {
  const runtime = runtimeFixture();
  runtime.getConnectionState = () => "closed";
  const entry = nearbySpatialSemantics(runtime, "player.one", {maximumDistance:10}).find(item => item.id === "connection.up");
  assert.equal(entry.available, false);
  assert.equal(entry.state, "closed");
  assert.match(describeNearbySpatialEntry(entry), /закрыт/);
});

test("connection speech uses the action and destination instead of an unreliable relative direction", () => {
  const entry = nearbySpatialSemantics(runtimeFixture(), "player.one", {maximumDistance:10,heading:180}).find(item => item.id === "connection.up");
  assert.ok(entry.elevationDelta > 0);
  const text = describeNearbySpatialEntry(entry, {actionReady:true});
  assert.match(text, /Нажми действие, чтобы подняться: Верхний этаж/);
  assert.doesNotMatch(text, /прямо|слева|справа|позади/);
});

test("directions remain available as data for systems that explicitly need them", () => {
  assert.equal(relativeSpatialDirection({x:0,y:0,heading:0},{x:0,y:-5}), "прямо");
  assert.equal(relativeSpatialDirection({x:0,y:0,heading:0},{x:5,y:0}), "справа");
  assert.equal(relativeSpatialDirection({x:0,y:0,heading:0},{x:-5,y:0}), "слева");
  assert.equal(relativeSpatialDirection({x:0,y:0,heading:0},{x:0,y:5}), "позади");
});

test("semantic collection is data-only and does not mutate the spatial world", () => {
  const runtime = runtimeFixture();
  const before = structuredClone([...runtime.location.spacesById.values()]);
  nearbySpatialSemantics(runtime, "player.one", {maximumDistance:10,heading:90});
  assert.deepEqual([...runtime.location.spacesById.values()], before);
});
