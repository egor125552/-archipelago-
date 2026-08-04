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
    const controller=await import(`/src/free-roam-heavy-ai-controller-v1.js?browser-standoff=${stamp}`);
    const memory=await import(`/src/free-roam-heavy-hull-damage-memory-v1.js?browser-standoff=${stamp}`);
    const base=await import(`/src/free-roam-heavy-pursuer.js?browser-standoff=${stamp}`);
    const normalizer=await import(`/src/free-roam-heavy-ai-base-normalizer-v1.js?browser-standoff=${stamp}`);

    const boat={
      id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
      x:404,y:306,heading:-90,turretHeading:-90,speed:0,
      hull:205,maxHull:260,engineHealth:180,maxEngineHealth:180,
      turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
      fireCooldown:0.25,aimRemaining:0,burstRemaining:0,burstCooldown:0,
      contactCooldown:1,ramCooldown:1,targetPlayer:0,
    };
    const world={
      time:100,events:[],
      players:[{x:160,y:150,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-pursuer",lastTargetRequestId:"heavy-pursuer"}}],
      boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-pursuer"}]},
      freeThreatDirector:{active:true,level:5,encounterId:72,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
      freeHeavyPursuer:{active:true,encounterId:72,boat,projectiles:[],nextProjectileId:1},
      freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
      freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
    };
    function step(dt=0.05) {
      world.time+=dt;
      controller.prepareHeavyAiControllerV1(world);
      memory.captureHeavyHullDamageCarryoverV1(world);
      base.updateHeavyPursuer(world,dt,{});
      normalizer.normalizeHeavyBaseStepV1(world);
      controller.finishHeavyAiControllerV1(world,dt);
      memory.finalizeHeavyHullDamageCarryoverV1(world);
    }
    function metres() {
      return Math.hypot(boat.x-world.players[0].x,boat.y-world.players[0].y);
    }

    controller.prepareHeavyAiControllerV1(world);
    const heavy=world.freeHeavyAiControllerV1.heavy;
    heavy.armourBreached=true;heavy.coreMax=260;heavy.phase="combat";
    controller.finishHeavyAiControllerV1(world,0.05);
    memory.finalizeHeavyHullDamageCarryoverV1(world);

    let standoffAt=null,shotsDuringStandoff=0,maxEmergencySpeed=boat.speed;
    const settled=[];
    for (let tick=0;tick<1400;tick+=1) {
      const before=world.freeHeavyPursuer.nextProjectileId;
      step();
      const after=world.freeHeavyPursuer.nextProjectileId;
      maxEmergencySpeed=Math.max(maxEmergencySpeed,boat.speed);
      if (heavy.hullEscapeMode==="standoff") {
        standoffAt??=world.time;
        shotsDuringStandoff+=Math.max(0,after-before);
        if (world.time-standoffAt>=8) settled.push({x:boat.x,y:boat.y,distance:metres()});
      }
    }
    const distances=settled.map(item=>item.distance);
    const xSpan=settled.length?Math.max(...settled.map(item=>item.x))-Math.min(...settled.map(item=>item.x)):Infinity;
    const ySpan=settled.length?Math.max(...settled.map(item=>item.y))-Math.min(...settled.map(item=>item.y)):Infinity;

    const player=world.players[0],dx=player.x-boat.x,dy=player.y-boat.y,length=Math.max(1,Math.hypot(dx,dy));
    player.x=boat.x+dx/length*(controller.HULL_STANDOFF_MIN-8);
    player.y=boat.y+dy/length*(controller.HULL_STANDOFF_MIN-8);
    const pressureStart=metres();
    step();
    const modeAfterPressure=heavy.hullEscapeMode,speedAfterPressure=boat.speed;
    for (let tick=0;tick<100;tick+=1) step();

    return {
      phase:heavy.phase,escapeReason:heavy.escapeReason,modeBeforePressure:"standoff",
      standoffAt,settledSamples:settled.length,
      minDistance:distances.length?Math.min(...distances):null,
      maxDistance:distances.length?Math.max(...distances):null,
      xSpan,ySpan,shotsDuringStandoff,maxEmergencySpeed,
      emergencySpeed:controller.emergencyEscapeSpeedV1(boat),
      standoffMin:controller.HULL_STANDOFF_MIN,standoffMax:controller.HULL_STANDOFF_MAX,
      modeAfterPressure,speedAfterPressure,modeAfterRecovery:heavy.hullEscapeMode,pressureStart,pressureEnd:metres(),
      announcements:world.events.filter(event=>event.type==="heavy-hull-standoff-v1").length,
    };
  });

  assert.deepEqual(browserErrors,[],browserErrors.join("\n"));
  assert.equal(result.phase,"escape");
  assert.equal(result.escapeReason,"hull-danger");
  assert.ok(result.standoffAt!==null,"Chromium never reached the low-hull firing position");
  assert.ok(result.settledSamples>=100,"Chromium did not hold the firing position");
  assert.ok(result.minDistance>=result.standoffMin-3,`Chromium standoff was too close: ${result.minDistance}`);
  assert.ok(result.maxDistance<=result.standoffMax+3,`Chromium standoff stayed outside turret range: ${result.maxDistance}`);
  assert.ok(Math.hypot(result.xSpan,result.ySpan)<18,`Chromium still oscillated along the edge: ${result.xSpan} by ${result.ySpan}`);
  assert.ok(result.shotsDuringStandoff>0,"Chromium mounted turret stayed silent at standoff");
  assert.ok(result.maxEmergencySpeed>=result.emergencySpeed*0.9,"initial survival sprint was not maximum speed");
  assert.ok(result.announcements>=1,"the firing-position cue was never emitted");
  assert.equal(result.modeAfterPressure,"flee","close pressure did not restart flight in Chromium");
  assert.ok(result.speedAfterPressure>=result.emergencySpeed*0.7,"renewed Chromium flight was not urgent");
  assert.ok(result.pressureEnd>=result.standoffMin-1,`Chromium failed to restore the safe firing band: ${result.pressureStart} -> ${result.pressureEnd}`);
  assert.equal(result.modeAfterRecovery,"standoff","Chromium did not settle again after reopening distance");

  console.log(JSON.stringify({scenario:"heavy-low-hull-standoff",...result},null,2));
} finally {
  await browser.close();
}
