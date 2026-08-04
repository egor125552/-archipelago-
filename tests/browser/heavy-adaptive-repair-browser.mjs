import assert from "node:assert/strict";
import {chromium} from "playwright";

const baseUrl=process.env.ARCHIPELAGO_TEST_URL||"http://127.0.0.1:4173";
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const browserErrors=[];
page.on("pageerror",error=>browserErrors.push(String(error?.stack||error)));
page.on("console",message=>{
  if (message.type()==="error") browserErrors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${baseUrl}/heavy-repair-browser-harness.html`,{waitUntil:"domcontentloaded"});
  const result=await page.evaluate(async()=>{
    const stamp=Date.now();
    const controller=await import(`/src/free-roam-heavy-ai-controller-v1.js?browser-adaptive=${stamp}`);
    const damageCurve=await import(`/src/free-roam-heavy-automatic-damage-v1.js?browser-adaptive=${stamp}`);
    const memory=await import(`/src/free-roam-heavy-hull-damage-memory-v1.js?browser-adaptive=${stamp}`);
    const base=await import(`/src/free-roam-heavy-pursuer.js?browser-adaptive=${stamp}`);
    const normalizer=await import(`/src/free-roam-heavy-ai-base-normalizer-v1.js?browser-adaptive=${stamp}`);

    function makeWorld({player={x:100,y:250},boatPoint={x:300,y:250},encounterId=91}={}) {
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
        freeThreatDirector:{active:true,level:5,encounterId,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
        freeHeavyPursuer:{active:true,encounterId,boat,projectiles:[],nextProjectileId:1},
        freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
        freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
      };
    }
    function initialize(world) {
      controller.prepareHeavyAiControllerV1(world);
      controller.finishHeavyAiControllerV1(world,0.05);
      memory.finalizeHeavyHullDamageCarryoverV1(world);
      return world.freeHeavyAiControllerV1.heavy;
    }
    function step(world,dt=0.05,between=null) {
      world.time+=dt;
      controller.prepareHeavyAiControllerV1(world);
      memory.captureHeavyHullDamageCarryoverV1(world);
      base.updateHeavyPursuer(world,dt,{});
      normalizer.normalizeHeavyBaseStepV1(world);
      if (typeof between==="function") between();
      controller.finishHeavyAiControllerV1(world,dt);
      memory.finalizeHeavyHullDamageCarryoverV1(world);
    }

    const damageSamples=[35,85,140,195,220].map((metres,index)=>{
      const world=makeWorld({player:{x:300-metres,y:250},encounterId:100+index});
      const before=world.freeHeavyPursuer.boat.hull;
      base.damageHeavyPursuer(world,"hull",12,0,{}, {weapon:"automatic"});
      const event=world.events.find(item=>item.type==="heavy-component-hit");
      return {metres,damage:before-world.freeHeavyPursuer.boat.hull,scale:event?.damageScale,eventDistance:event?.distance};
    });

    const returningWorld=makeWorld({player:{x:210,y:200},boatPoint:{x:190,y:84},encounterId:111});
    const returningHeavy=initialize(returningWorld),returningBoat=returningWorld.freeHeavyPursuer.boat;
    Object.assign(returningHeavy,{phase:"returning",returnStartedAt:returningWorld.time,destination:{x:350,y:250},repairSystem:null,escapeReason:null});
    Object.assign(returningBoat,{turretHealth:163.2,turretDisabled:false,fireCooldown:0.1,turretHeading:158,heading:158,speed:12.1});
    const returnStart=returningWorld.time;
    let firstShotAt=null;
    for (let tick=0;tick<160;tick+=1) {
      step(returningWorld);
      if (firstShotAt===null&&returningWorld.events.some(event=>event.type==="heavy-gun-shot")) firstShotAt=returningWorld.time;
    }

    const repairWorld=makeWorld({player:{x:100,y:250},encounterId:112});
    const repairHeavy=initialize(repairWorld),repairBoat=repairWorld.freeHeavyPursuer.boat;
    Object.assign(repairBoat,{turretHealth:0,turretDisabled:true,speed:0,fireCooldown:0.2});
    Object.assign(repairHeavy,{
      phase:"escape",escapeReason:"repair",repairSystem:"turret",repairPlates:3,
      destination:{x:repairBoat.x,y:repairBoat.y},repairRouteClearance:200,incomingHullDps:0,
    });
    const repairStart=repairWorld.time;
    let repairCompleteAt=null;
    for (let tick=0;tick<220;tick+=1) {
      const weakHit=tick>0&&tick%20===0;
      step(repairWorld,0.05,()=>{
        if (weakHit) base.damageHeavyPursuer(repairWorld,"hull",12,0,{}, {weapon:"automatic"});
      });
      if (repairCompleteAt===null&&repairWorld.events.some(event=>event.type==="heavy-repair-complete-v1")) repairCompleteAt=repairWorld.time;
    }
    const repairStopping=repairWorld.events.find(event=>event.type==="heavy-repair-stopping-v1");

    const abortWorld=makeWorld({player:{x:100,y:250},encounterId:113});
    const abortHeavy=initialize(abortWorld),abortBoat=abortWorld.freeHeavyPursuer.boat;
    Object.assign(abortBoat,{turretHealth:0,turretDisabled:true,speed:0});
    Object.assign(abortHeavy,{
      phase:"escape",escapeReason:"repair",repairSystem:"turret",repairPlates:3,
      destination:{x:abortBoat.x,y:abortBoat.y},repairRouteClearance:200,incomingHullDps:0,
    });
    for (let tick=0;tick<45;tick+=1) step(abortWorld);
    const phaseBeforeClosing=abortHeavy.phase;
    abortWorld.players[0].x=abortBoat.x-140;
    abortWorld.players[0].y=abortBoat.y;
    step(abortWorld);

    return {
      damageSamples,
      expectedDamage:damageSamples.map(sample=>damageCurve.heavyAutomaticDamageV1(12,sample.metres)),
      returning:{
        firstShotDelay:firstShotAt===null?null:firstShotAt-returnStart,
        phase:returningHeavy.phase,
        projectilesCreated:returningWorld.freeHeavyPursuer.nextProjectileId-1,
        returnedEvents:returningWorld.events.filter(event=>event.type==="heavy-repair-returned-v1").length,
      },
      repair:{
        mode:repairStopping?.mode,duration:repairStopping?.duration,
        completeDelay:repairCompleteAt===null?null:repairCompleteAt-repairStart,
        turretDisabled:repairBoat.turretDisabled,turretHealth:repairBoat.turretHealth,
        shots:repairWorld.events.filter(event=>event.type==="heavy-gun-shot").length,
      },
      abort:{
        phaseBeforeClosing,phase:abortHeavy.phase,escapeReason:abortHeavy.escapeReason,
        abortedEvents:abortWorld.events.filter(event=>event.type==="heavy-repair-aborted-v1").length,
        turretDisabled:abortBoat.turretDisabled,
      },
    };
  });

  assert.deepEqual(browserErrors,[],browserErrors.join("\n"));
  for (let index=0;index<result.damageSamples.length;index+=1) {
    const sample=result.damageSamples[index];
    assert.ok(Math.abs(sample.damage-result.expectedDamage[index])<0.001,`Chromium wrong damage at ${sample.metres}m`);
    if (index>0) assert.ok(result.damageSamples[index-1].damage>sample.damage,"Chromium damage did not fall with distance");
    assert.ok(Math.abs(sample.eventDistance-sample.metres)<0.001,"Chromium event lost distance");
  }
  assert.equal(result.damageSamples[0].damage,12);
  assert.ok(result.damageSamples.at(-1).damage<=1.5);

  assert.ok(result.returning.firstShotDelay!==null,"Chromium repaired turret stayed silent");
  assert.ok(result.returning.firstShotDelay<6,`Chromium return fire took ${result.returning.firstShotDelay}s`);
  assert.equal(result.returning.phase,"combat");
  assert.ok(result.returning.projectilesCreated>0);
  assert.ok(result.returning.returnedEvents>=1);

  assert.equal(result.repair.mode,"field");
  assert.equal(result.repair.duration,7);
  assert.ok(result.repair.completeDelay!==null,"Chromium field repair never completed");
  assert.ok(result.repair.completeDelay<9.5,`Chromium field repair took ${result.repair.completeDelay}s`);
  assert.equal(result.repair.turretDisabled,false);
  assert.ok(result.repair.turretHealth>0);
  assert.ok(result.repair.shots>0,"Chromium repaired turret did not fire");

  assert.ok(["stopping","repairing"].includes(result.abort.phaseBeforeClosing));
  assert.equal(result.abort.phase,"escape");
  assert.equal(result.abort.escapeReason,"repair");
  assert.ok(result.abort.abortedEvents>=1);
  assert.equal(result.abort.turretDisabled,true);

  console.log(JSON.stringify({scenario:"heavy-adaptive-repair-and-distance-damage",...result},null,2));
} finally {
  await browser.close();
}
