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
    const controller=await import(`/src/free-roam-heavy-ai-controller-v1.js?browser-repair=${Date.now()}`);
    const boat={
      id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
      x:300,y:250,heading:0,turretHeading:0,speed:8,
      hull:260,maxHull:260,engineHealth:180,maxEngineHealth:180,
      turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
      fireCooldown:1,burstRemaining:0,burstCooldown:0,aimRemaining:0,targetPlayer:0,
    };
    const world={
      time:100,events:[],
      players:[{x:210,y:200,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-turret",lastTargetRequestId:"heavy-turret"}}],
      boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-turret"}]},
      freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
      freeHeavyPursuer:{active:true,encounterId:1,boat,projectiles:[],nextProjectileId:1},
      freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
      freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
    };

    controller.prepareHeavyAiControllerV1(world);
    const heavy=world.freeHeavyAiControllerV1.heavy;
    heavy.armourBreached=true;
    heavy.phase="combat";
    boat.turretHealth=0;
    boat.turretDisabled=true;
    controller.finishHeavyAiControllerV1(world,0.05);

    const phases=[heavy.phase];
    let maxDistanceFromDestination=0;
    let completedAt=null;
    for (let tick=0;tick<1800;tick+=1) {
      world.time+=0.05;
      controller.prepareHeavyAiControllerV1(world);
      controller.finishHeavyAiControllerV1(world,0.05);
      if (phases.at(-1)!==heavy.phase) phases.push(heavy.phase);
      if (heavy.destination) {
        maxDistanceFromDestination=Math.max(maxDistanceFromDestination,Math.hypot(boat.x-heavy.destination.x,boat.y-heavy.destination.y));
      }
      if (world.events.some(event=>event.type==="heavy-repair-complete-v1")) {
        completedAt=world.time;
        break;
      }
    }

    for (let tick=0;tick<500;tick+=1) {
      world.time+=0.05;
      controller.prepareHeavyAiControllerV1(world);
      controller.finishHeavyAiControllerV1(world,0.05);
    }

    return {
      phases,
      completedAt,
      maxDistanceFromDestination,
      phase:heavy.phase,
      turretHealth:boat.turretHealth,
      turretDisabled:boat.turretDisabled,
      repairStarts:world.events.filter(event=>event.type==="heavy-repair-start-v1").length,
      repairStops:world.events.filter(event=>event.type==="heavy-repair-stopping-v1").length,
      repairCompletes:world.events.filter(event=>event.type==="heavy-repair-complete-v1").length,
      recoveryStarts:world.events.filter(event=>event.type==="heavy-system-recovery-v1").length,
      repairRouteClearance:heavy.repairRouteClearance,
      fixedThreshold:controller.REPAIR_START_CLEARANCE,
      finalPosition:{x:boat.x,y:boat.y,speed:boat.speed},
    };
  });

  assert.deepEqual(browserErrors,[],browserErrors.join("\n"));
  assert.ok(result.completedAt!==null,"the heavy boat never completed repair in Chromium");
  assert.ok(result.phases.includes("escape"),`missing escape: ${result.phases.join(" -> ")}`);
  assert.ok(result.phases.includes("stopping"),`missing stopping: ${result.phases.join(" -> ")}`);
  assert.ok(result.phases.includes("repairing"),`missing repairing: ${result.phases.join(" -> ")}`);
  assert.equal(result.repairStops,1,"the repair route must end in one physical stop");
  assert.equal(result.repairStarts,1,"repair must start exactly once");
  assert.equal(result.repairCompletes,1,"repair must complete exactly once");
  assert.equal(result.recoveryStarts,1,"the repaired turret must not be mistaken for a new failure");
  assert.ok(result.turretHealth>0,"turret health was not restored");
  assert.ok(["returning","combat"].includes(result.phase),`unexpected final phase ${result.phase}`);

  console.log(JSON.stringify({scenario:"central-player-destroyed-turret",...result},null,2));
} finally {
  await browser.close();
}
