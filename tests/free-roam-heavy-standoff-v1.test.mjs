import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareHeavyAiControllerV1,
  finishHeavyAiControllerV1,
  emergencyEscapeSpeedV1,
  HULL_STANDOFF_MIN,
  HULL_STANDOFF_MAX,
} from "../public/src/free-roam-heavy-ai-controller-v1.js";
import {
  captureHeavyHullDamageCarryoverV1,
  finalizeHeavyHullDamageCarryoverV1,
} from "../public/src/free-roam-heavy-hull-damage-memory-v1.js";
import {normalizeHeavyBaseStepV1} from "../public/src/free-roam-heavy-ai-base-normalizer-v1.js";
import {updateHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";

function makeWorld() {
  const boat={
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:404,y:306,heading:-90,turretHeading:-90,speed:0,
    hull:205,maxHull:260,engineHealth:180,maxEngineHealth:180,
    turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
    fireCooldown:0.25,aimRemaining:0,burstRemaining:0,burstCooldown:0,
    contactCooldown:1,ramCooldown:1,targetPlayer:0,
  };
  return {
    time:100,events:[],
    players:[{x:160,y:150,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-pursuer",lastTargetRequestId:"heavy-pursuer"}}],
    boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-pursuer"}]},
    freeThreatDirector:{active:true,level:5,encounterId:71,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:71,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

function productionStep(world,dt=0.05) {
  world.time+=dt;
  prepareHeavyAiControllerV1(world);
  captureHeavyHullDamageCarryoverV1(world);
  updateHeavyPursuer(world,dt,{});
  normalizeHeavyBaseStepV1(world);
  finishHeavyAiControllerV1(world,dt);
  finalizeHeavyHullDamageCarryoverV1(world);
}

function metres(world) {
  const boat=world.freeHeavyPursuer.boat,player=world.players[0];
  return Math.hypot(boat.x-player.x,boat.y-player.y);
}

test("an isolated low-hull heavy boat settles into its own firing range instead of swinging across the map edge", () => {
  const world=makeWorld(),boat=world.freeHeavyPursuer.boat;
  prepareHeavyAiControllerV1(world);
  const heavy=world.freeHeavyAiControllerV1.heavy;
  heavy.armourBreached=true;heavy.coreMax=260;heavy.phase="combat";
  finishHeavyAiControllerV1(world,0.05);
  finalizeHeavyHullDamageCarryoverV1(world);

  let standoffAt=null,shotsDuringStandoff=0;
  const settled=[];
  for (let tick=0;tick<1400;tick+=1) {
    const before=world.freeHeavyPursuer.nextProjectileId;
    productionStep(world,0.05);
    const after=world.freeHeavyPursuer.nextProjectileId;
    if (heavy.hullEscapeMode==="standoff") {
      standoffAt??=world.time;
      shotsDuringStandoff+=Math.max(0,after-before);
      if (world.time-standoffAt>=8) settled.push({x:boat.x,y:boat.y,distance:metres(world)});
    }
  }

  assert.equal(heavy.phase,"escape");
  assert.equal(heavy.escapeReason,"hull-danger");
  assert.equal(heavy.hullEscapeMode,"standoff","the boat never left permanent flee mode");
  assert.ok(standoffAt!==null,"the boat never occupied a firing position");
  assert.ok(settled.length>=100,"the firing position was not held long enough");
  const distances=settled.map(item=>item.distance);
  assert.ok(Math.min(...distances)>=HULL_STANDOFF_MIN-3,`standoff came too close: ${Math.min(...distances)}`);
  assert.ok(Math.max(...distances)<=HULL_STANDOFF_MAX+3,`standoff remained outside turret range: ${Math.max(...distances)}`);
  const xSpan=Math.max(...settled.map(item=>item.x))-Math.min(...settled.map(item=>item.x));
  const ySpan=Math.max(...settled.map(item=>item.y))-Math.min(...settled.map(item=>item.y));
  assert.ok(Math.hypot(xSpan,ySpan)<18,`the map-edge pendulum survived: spans ${xSpan} by ${ySpan}`);
  assert.ok(shotsDuringStandoff>0,"the mounted installation stayed silent from the firing position");

  const player=world.players[0],dx=player.x-boat.x,dy=player.y-boat.y,length=Math.max(1,Math.hypot(dx,dy));
  player.x=boat.x+dx/length*(HULL_STANDOFF_MIN-8);
  player.y=boat.y+dy/length*(HULL_STANDOFF_MIN-8);
  const beforePressure=metres(world);
  productionStep(world,0.05);
  assert.equal(heavy.hullEscapeMode,"flee","close pressure did not restart survival flight");
  assert.ok(boat.speed>=emergencyEscapeSpeedV1(boat)*0.7,"the renewed escape did not use emergency speed");
  for (let tick=0;tick<100;tick+=1) productionStep(world,0.05);
  assert.ok(metres(world)>=HULL_STANDOFF_MIN-1,`the boat failed to restore the safe firing band: ${beforePressure} -> ${metres(world)}`);
  assert.equal(heavy.hullEscapeMode,"standoff","the boat did not settle again after reopening distance");
});
