import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareHeavyAiControllerV1,
  finishHeavyAiControllerV1,
  emergencyEscapeSpeedV1,
} from "../public/src/free-roam-heavy-ai-controller-v1.js";
import {normalizeHeavyBaseStepV1} from "../public/src/free-roam-heavy-ai-base-normalizer-v1.js";
import {
  damageHeavyPursuer,
  updateHeavyPursuer,
} from "../public/src/free-roam-heavy-pursuer.js";

function makeWorld({hull=700,maxHull=700,player={x:300,y:20}}={}) {
  const boat={
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:300,y:250,heading:0,turretHeading:0,speed:0,
    hull,maxHull,engineHealth:180,maxEngineHealth:180,
    turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
    fireCooldown:999,aimRemaining:0,burstRemaining:0,burstCooldown:0,
    contactCooldown:1,ramCooldown:1,targetPlayer:0,
  };
  return {
    time:100,events:[],
    players:[{...player,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-pursuer",lastTargetRequestId:"heavy-pursuer"}}],
    boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-pursuer"}]},
    freeThreatDirector:{active:true,level:5,encounterId:31,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:31,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

function productionStep(world,dt=0.05,betweenBaseAndFinish=null) {
  world.time+=dt;
  prepareHeavyAiControllerV1(world);
  updateHeavyPursuer(world,dt,{});
  normalizeHeavyBaseStepV1(world);
  if (typeof betweenBaseAndFinish==="function") betweenBaseAndFinish();
  finishHeavyAiControllerV1(world,dt);
}

test("combat releases the legacy 999 second turret cooldown and the real installation fires", () => {
  const world=makeWorld();
  for (let tick=0;tick<100;tick+=1) productionStep(world,0.05);
  const types=world.events.map(event=>event.type);
  assert.ok(types.includes("heavy-gun-windup"),"the mounted installation never started aiming");
  assert.ok(types.includes("heavy-gun-shot"),"the mounted installation never fired a physical projectile");
  assert.ok(Number(world.freeHeavyPursuer.boat.fireCooldown)<30,"the poisoned legacy cooldown survived combat entry");
});

test("sustained automatic damage predicts a lethal chase and starts escape well above 200 hull", () => {
  const world=makeWorld({player:{x:210,y:200}});
  let escapeHull=null;
  for (let tick=0;tick<35;tick+=1) {
    productionStep(world,0.08,()=>damageHeavyPursuer(world,"hull",12,0,{}, {weapon:"automatic"}));
    const heavy=world.freeHeavyAiControllerV1.heavy;
    if (heavy.phase==="escape"&&heavy.escapeReason==="hull-danger") {escapeHull=world.freeHeavyPursuer.boat.hull;break;}
  }
  const heavy=world.freeHeavyAiControllerV1.heavy,boat=world.freeHeavyPursuer.boat;
  assert.ok(escapeHull!==null,"predictive hull escape never started");
  assert.ok(escapeHull>200,`escape started too late at ${escapeHull}`);
  assert.equal(heavy.escapeReason,"hull-danger");
  assert.ok(boat.speed>=emergencyEscapeSpeedV1(boat)*0.7,"the boat did not commit to emergency speed");
  assert.equal(world.events.filter(event=>event.type==="heavy-hull-danger-escape-v1").length,1);
});

test("one accidental mega-bomb clip makes an exposed core retreat before the static threshold", () => {
  const world=makeWorld({hull:260,maxHull:260,player:{x:210,y:200}});
  prepareHeavyAiControllerV1(world);
  const heavy=world.freeHeavyAiControllerV1.heavy;
  heavy.armourBreached=true;heavy.coreMax=260;heavy.phase="combat";
  updateHeavyPursuer(world,0.05,{});normalizeHeavyBaseStepV1(world);
  damageHeavyPursuer(world,"hull",20,0,{}, {weapon:"mega-bomb"});
  finishHeavyAiControllerV1(world,0.05);
  assert.equal(world.freeHeavyPursuer.boat.hull,240);
  assert.ok(240>Math.min(220,260*0.84),"test must remain above the ordinary low-hull threshold");
  assert.equal(heavy.phase,"escape");assert.equal(heavy.escapeReason,"hull-danger");
});

test("critical escape persists, reaches emergency speed and keeps a healthy turret firing cover", () => {
  const world=makeWorld({hull:205,maxHull:260,player:{x:210,y:200}});
  prepareHeavyAiControllerV1(world);
  const heavy=world.freeHeavyAiControllerV1.heavy;
  heavy.armourBreached=true;heavy.coreMax=260;heavy.phase="combat";
  finishHeavyAiControllerV1(world,0.05);
  const boat=world.freeHeavyPursuer.boat;
  const initialDistance=Math.hypot(boat.x-world.players[0].x,boat.y-world.players[0].y);
  let maxSpeed=boat.speed,shotsDuringEscape=0;
  for (let tick=0;tick<160;tick+=1) {
    const before=world.events.filter(event=>event.type==="heavy-gun-shot").length;
    productionStep(world,0.05);
    const after=world.events.filter(event=>event.type==="heavy-gun-shot").length;
    if (heavy.phase==="escape"&&heavy.escapeReason==="hull-danger") shotsDuringEscape+=Math.max(0,after-before);
    maxSpeed=Math.max(maxSpeed,boat.speed);
  }
  const finalDistance=Math.hypot(boat.x-world.players[0].x,boat.y-world.players[0].y);
  assert.equal(heavy.phase,"escape");assert.equal(heavy.escapeReason,"hull-danger");
  assert.ok(maxSpeed>=emergencyEscapeSpeedV1(boat)*0.9,`maximum escape speed was only ${maxSpeed}`);
  assert.ok(finalDistance>initialDistance+35,`distance grew only from ${initialDistance} to ${finalDistance}`);
  assert.ok(shotsDuringEscape>0,"the healthy turret was muted during survival escape");
});
