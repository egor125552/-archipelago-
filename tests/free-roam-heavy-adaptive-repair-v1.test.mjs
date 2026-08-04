import test from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_REPAIR_SECONDS,
  finishHeavyAiControllerV1,
  prepareHeavyAiControllerV1,
  repairOpportunityV1,
} from "../public/src/free-roam-heavy-ai-controller-v1.js";
import {
  heavyAutomaticDamageScaleV1,
  heavyAutomaticDamageV1,
} from "../public/src/free-roam-heavy-automatic-damage-v1.js";
import {
  damageHeavyPursuer,
  updateHeavyPursuer,
} from "../public/src/free-roam-heavy-pursuer.js";
import {
  captureHeavyHullDamageCarryoverV1,
  finalizeHeavyHullDamageCarryoverV1,
} from "../public/src/free-roam-heavy-hull-damage-memory-v1.js";
import {normalizeHeavyBaseStepV1} from "../public/src/free-roam-heavy-ai-base-normalizer-v1.js";

function makeWorld({player={x:100,y:250},boatPoint={x:300,y:250}}={}) {
  const boat={
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:boatPoint.x,y:boatPoint.y,heading:-90,turretHeading:-90,speed:0,
    hull:700,maxHull:700,engineHealth:180,maxEngineHealth:180,
    turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
    fireCooldown:0.2,aimRemaining:0,burstRemaining:0,burstCooldown:0,
    contactCooldown:1,ramCooldown:1,targetPlayer:0,
  };
  return {
    time:100,events:[],
    players:[{...player,heading:90,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-pursuer",lastTargetRequestId:"heavy-pursuer"}}],
    boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-pursuer"}]},
    freeThreatDirector:{active:true,level:5,encounterId:81,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:81,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

function initialize(world) {
  prepareHeavyAiControllerV1(world);
  finishHeavyAiControllerV1(world,0.05);
  finalizeHeavyHullDamageCarryoverV1(world);
  return world.freeHeavyAiControllerV1.heavy;
}

function productionStep(world,dt=0.05,betweenBaseAndFinish=null) {
  world.time+=dt;
  prepareHeavyAiControllerV1(world);
  captureHeavyHullDamageCarryoverV1(world);
  updateHeavyPursuer(world,dt,{});
  normalizeHeavyBaseStepV1(world);
  if (typeof betweenBaseAndFinish==="function") betweenBaseAndFinish();
  finishHeavyAiControllerV1(world,dt);
  finalizeHeavyHullDamageCarryoverV1(world);
}

test("automatic damage against the heavy boat falls continuously with distance", () => {
  const samples=[35,85,140,195,220].map(metres=>{
    const world=makeWorld({player:{x:300-metres,y:250}});
    const before=world.freeHeavyPursuer.boat.hull;
    damageHeavyPursuer(world,"hull",12,0,{}, {weapon:"automatic"});
    const event=world.events.find(item=>item.type==="heavy-component-hit");
    return {
      metres,
      damage:before-world.freeHeavyPursuer.boat.hull,
      expected:heavyAutomaticDamageV1(12,metres),
      scale:heavyAutomaticDamageScaleV1(metres),
      event,
    };
  });

  for (let index=1;index<samples.length;index+=1) {
    assert.ok(samples[index-1].damage>samples[index].damage,
      `damage did not fall: ${samples[index-1].metres}m=${samples[index-1].damage}, ${samples[index].metres}m=${samples[index].damage}`);
  }
  for (const sample of samples) {
    assert.ok(Math.abs(sample.damage-sample.expected)<0.001,`wrong damage at ${sample.metres} metres`);
    assert.ok(Math.abs(Number(sample.event?.distance)-sample.metres)<0.001,"event lost shot distance");
    assert.ok(Math.abs(Number(sample.event?.damageScale)-sample.scale)<0.001,"event lost damage scale");
    assert.ok(Math.abs(Number(sample.event?.damage)-sample.damage)<0.001,"event lost applied damage");
  }
  assert.equal(samples[0].damage,12);
  assert.ok(samples.at(-1).damage<=1.5,`220 metre damage remained ${samples.at(-1).damage}`);
});

test("weak long-range automatic fire does not trigger the same panic as a close burst", () => {
  const world=makeWorld({player:{x:100,y:250}});
  initialize(world);
  for (let hit=0;hit<5;hit+=1) {
    productionStep(world,0.18,()=>damageHeavyPursuer(world,"hull",12,0,{}, {weapon:"automatic"}));
  }
  const heavy=world.freeHeavyAiControllerV1.heavy;
  assert.equal(world.events.some(event=>event.type==="heavy-automatic-suppression-escape-v1"),false);
  assert.notEqual(heavy.escapeReason,"suppression");
  assert.ok(world.freeHeavyPursuer.boat.hull>680,`weak far fire removed too much hull: ${world.freeHeavyPursuer.boat.hull}`);
});

test("archive regression: a repaired healthy turret fires while returning and cannot stay silent for 46 seconds", () => {
  const world=makeWorld({player:{x:210,y:200},boatPoint:{x:190,y:84}});
  const heavy=initialize(world),boat=world.freeHeavyPursuer.boat;
  Object.assign(heavy,{phase:"returning",returnStartedAt:world.time,destination:{x:350,y:250},repairSystem:null,escapeReason:null});
  Object.assign(boat,{turretHealth:163.2,turretDisabled:false,fireCooldown:0.1,turretHeading:158,heading:158,speed:12.1});
  const started=world.time;
  let firstShotAt=null;
  for (let tick=0;tick<160;tick+=1) {
    productionStep(world,0.05);
    if (firstShotAt===null&&world.events.some(event=>event.type==="heavy-gun-shot")) firstShotAt=world.time;
  }
  assert.ok(firstShotAt!==null,"the repaired installation stayed silent");
  assert.ok(firstShotAt-started<6,`first shot took ${firstShotAt-started} seconds`);
  assert.equal(heavy.phase,"combat","returning survived beyond its four-second guard");
  assert.ok(world.events.some(event=>event.type==="heavy-repair-returned-v1"));
  assert.ok(world.freeHeavyPursuer.nextProjectileId>1,"no physical heavy projectile was created");
});

test("the heavy boat completes a seven-second field repair under weak survivable fire", () => {
  const world=makeWorld({player:{x:100,y:250}});
  const heavy=initialize(world),boat=world.freeHeavyPursuer.boat;
  Object.assign(boat,{turretHealth:0,turretDisabled:true,speed:0,fireCooldown:0.2});
  Object.assign(heavy,{
    phase:"escape",escapeReason:"repair",repairSystem:"turret",repairPlates:3,
    destination:{x:boat.x,y:boat.y},repairRouteClearance:200,incomingHullDps:0,
  });
  assert.equal(repairOpportunityV1(world,boat,heavy).safe,true);

  const started=world.time;
  let completedAt=null;
  for (let tick=0;tick<220;tick+=1) {
    const weakHit=tick>0&&tick%20===0;
    productionStep(world,0.05,()=>{
      if (weakHit) damageHeavyPursuer(world,"hull",12,0,{}, {weapon:"automatic"});
    });
    if (completedAt===null&&world.events.some(event=>event.type==="heavy-repair-complete-v1")) completedAt=world.time;
  }
  const stopping=world.events.find(event=>event.type==="heavy-repair-stopping-v1");
  assert.equal(stopping?.mode,"field");
  assert.equal(stopping?.duration,FIELD_REPAIR_SECONDS);
  assert.ok(completedAt!==null,"field repair never completed");
  assert.ok(completedAt-started<9.5,`seven-second repair completed after ${completedAt-started} seconds`);
  assert.equal(boat.turretDisabled,false);
  assert.ok(boat.turretHealth>0);
  assert.ok(world.events.some(event=>event.type==="heavy-gun-shot"),"repaired turret did not resume firing");
});

test("closing the distance aborts a field repair instead of granting free healing", () => {
  const world=makeWorld({player:{x:100,y:250}});
  const heavy=initialize(world),boat=world.freeHeavyPursuer.boat;
  Object.assign(boat,{turretHealth:0,turretDisabled:true,speed:0});
  Object.assign(heavy,{
    phase:"escape",escapeReason:"repair",repairSystem:"turret",repairPlates:3,
    destination:{x:boat.x,y:boat.y},repairRouteClearance:200,incomingHullDps:0,
  });
  for (let tick=0;tick<45;tick+=1) productionStep(world,0.05);
  assert.ok(["stopping","repairing"].includes(heavy.phase),`repair never began: ${heavy.phase}`);
  world.players[0].x=boat.x-140;
  world.players[0].y=boat.y;
  productionStep(world,0.05);
  assert.equal(heavy.phase,"escape");
  assert.equal(heavy.escapeReason,"repair");
  assert.ok(world.events.some(event=>event.type==="heavy-repair-aborted-v1"));
  assert.equal(boat.turretDisabled,true);
});
