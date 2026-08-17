import test from "node:test";
import assert from "node:assert/strict";

import {formatSpatialMetres} from "../public/src/spatial/spatial-accessibility.js";
import {FreeRoamSpatialManager} from "../public/src/spatial/spatial-free-roam-integration.js";

const rect = (w, h, z = 3) => ({outer:[[0,0,0],[w,0,0],[w,h,0],[0,h,0]],minZ:0,maxZ:z});

function manager() {
  const definition = {
    schemaVersion:1,
    id:"location.boundary.test",
    label:"Тестовая локация",
    presentation:{label:"Тестовая локация",description:"test",role:"location"},
    worldTransform:{position:{x:100,y:50,z:0},yaw:0},
    persistence:{version:1},
    spaces:[{
      id:"floor.low",label:"Первый этаж",presentation:{label:"Первый этаж",description:"",role:"indoor"},
      transform:{position:{x:0,y:0,z:0},yaw:0},shape:rect(20,20),
      anchors:[{id:"entry",kind:"spawn",label:"Вход",position:[2,2,0]}],objects:[],
    }],
    connections:[],
    spawns:[{id:"spawn",spaceId:"floor.low",anchorId:"entry",mode:"foot"}],
    modules:[
      {id:"navigation",type:"spatial.navigation",config:{}},
      {id:"accessibility",type:"spatial.accessibility",config:{}},
      {id:"lifecycle",type:"spatial.lifecycle",config:{}},
      {id:"replication",type:"spatial.replication",config:{}},
      {id:"persistence",type:"spatial.persistence",config:{}},
    ],
  };
  return new FreeRoamSpatialManager({locations:[{definition,portal:{position:{x:100,y:50,z:0},radius:6,spawnId:"spawn",outsideLabel:"берег"}}]});
}

function world() {
  return {
    time:0,
    players:[{id:0,mode:"foot",activeBoat:null,x:100,y:50,heading:0,jumpHeight:0,jumpVelocity:0,airborne:false}],
    events:[],
    freeActivities:{presence:[true]},
    freeScenario:{phase:"salvage",targets:[null],guideEnabled:[false],sonarCooldown:[0],beaconUntil:[0]},
    freeContracts:{encounterActive:false},
  };
}

test("spatial metre formatter uses Russian number forms", () => {
  assert.equal(formatSpatialMetres(1), "1 метр");
  assert.equal(formatSpatialMetres(2), "2 метра");
  assert.equal(formatSpatialMetres(5), "5 метров");
  assert.equal(formatSpatialMetres(11), "11 метров");
  assert.equal(formatSpatialMetres(14), "14 метров");
  assert.equal(formatSpatialMetres(21), "21 метр");
  assert.equal(formatSpatialMetres(22), "22 метра");
  assert.equal(formatSpatialMetres(1.5, {precision:1}), "1,5 метра");
});

test("holding movement into one spatial boundary announces it once and retreat rearms the cue", () => {
  const m = manager();
  const w = world();
  m.initialize(w);
  m.prepareInput(w, 0, {action:true,sonar:false,guide:false});
  m.prepareInput(w, 0, {action:false,sonar:false,guide:false});
  assert.equal(w.players[0].spatialLocationId, "location.boundary.test");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    w.players[0].x = 121;
    w.players[0].y = 52;
    m.sync(w);
  }
  assert.equal(w.events.filter(event => event.type === "location-boundary").length, 1);

  w.players[0].x = 103;
  w.players[0].y = 52;
  m.sync(w);
  w.players[0].x = 121;
  w.players[0].y = 52;
  m.sync(w);
  assert.equal(w.events.filter(event => event.type === "location-boundary").length, 2);
});
