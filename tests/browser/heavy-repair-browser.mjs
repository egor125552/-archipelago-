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
    const controller=await import(`/src/free-roam-heavy-ai-controller-v1.js?browser-heavy=${stamp}`);
    const base=await import(`/src/free-roam-heavy-pursuer.js?browser-heavy=${stamp}`);
    const normalizer=await import(`/src/free-roam-heavy-ai-base-normalizer-v1.js?browser-heavy=${stamp}`);

    function makeWorld({hull=260,maxHull=260,player={x:210,y:200},fireCooldown=1}={}) {
      const boat={
        id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
        x:300,y:250,heading:0,turretHeading:0,speed:8,
        hull,maxHull,engineHealth:180,maxEngineHealth:180,
        turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
        fireCooldown,burstRemaining:0,burstCooldown:0,aimRemaining:0,
        contactCooldown:1,ramCooldown:1,targetPlayer:0,
      };
      return {
        time:100,events:[],
        players:[{...player,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-pursuer",lastTargetRequestId:"heavy-pursuer"}}],
        boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-pursuer"}]},
        freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
        freeHeavyPursuer:{active:true,encounterId:1,boat,projectiles:[],nextProjectileId:1},
        freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
        freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
      };
    }
    function productionStep(world,dt=0.05,betweenBaseAndFinish=null) {
      world.time+=dt;
      controller.prepareHeavyAiControllerV1(world);
      base.updateHeavyPursuer(world,dt,{});
      normalizer.normalizeHeavyBaseStepV1(world);
      if (typeof betweenBaseAndFinish==="function") betweenBaseAndFinish();
      controller.finishHeavyAiControllerV1(world,dt);
    }

    const repairWorld=makeWorld();
    const repairBoat=repairWorld.freeHeavyPursuer.boat;
    controller.prepareHeavyAiControllerV1(repairWorld);
    const repairHeavy=repairWorld.freeHeavyAiControllerV1.heavy;
    repairHeavy.armourBreached=true;
    repairHeavy.phase="combat";
    repairBoat.turretHealth=0;
    repairBoat.turretDisabled=true;
    controller.finishHeavyAiControllerV1(repairWorld,0.05);

    const repairPhases=[repairHeavy.phase];
    let completedAt=null;
    for (let tick=0;tick<1800;tick+=1) {
      repairWorld.time+=0.05;
      controller.prepareHeavyAiControllerV1(repairWorld);
      controller.finishHeavyAiControllerV1(repairWorld,0.05);
      if (repairPhases.at(-1)!==repairHeavy.phase) repairPhases.push(repairHeavy.phase);
      if (repairWorld.events.some(event=>event.type==="heavy-repair-complete-v1")) {
        completedAt=repairWorld.time;
        break;
      }
    }
    for (let tick=0;tick<500;tick+=1) {
      repairWorld.time+=0.05;
      controller.prepareHeavyAiControllerV1(repairWorld);
      controller.finishHeavyAiControllerV1(repairWorld,0.05);
    }
    const repair={
      phases:repairPhases,completedAt,phase:repairHeavy.phase,
      turretHealth:repairBoat.turretHealth,turretDisabled:repairBoat.turretDisabled,
      repairStarts:repairWorld.events.filter(event=>event.type==="heavy-repair-start-v1").length,
      repairStops:repairWorld.events.filter(event=>event.type==="heavy-repair-stopping-v1").length,
      repairCompletes:repairWorld.events.filter(event=>event.type==="heavy-repair-complete-v1").length,
      recoveryStarts:repairWorld.events.filter(event=>event.type==="heavy-system-recovery-v1").length,
    };

    const turretWorld=makeWorld({hull:700,maxHull:700,player:{x:300,y:20},fireCooldown:999});
    for (let tick=0;tick<100;tick+=1) productionStep(turretWorld,0.05);
    const turret={
      windups:turretWorld.events.filter(event=>event.type==="heavy-gun-windup").length,
      shots:turretWorld.events.filter(event=>event.type==="heavy-gun-shot").length,
      fireCooldown:turretWorld.freeHeavyPursuer.boat.fireCooldown,
      projectiles:turretWorld.freeHeavyPursuer.projectiles.length,
    };

    const survivalWorld=makeWorld({hull:700,maxHull:700,player:{x:210,y:200},fireCooldown:999});
    const survivalBoat=survivalWorld.freeHeavyPursuer.boat;
    let escapeHull=null,escapeAt=null;
    for (let tick=0;tick<35;tick+=1) {
      productionStep(survivalWorld,0.08,()=>base.damageHeavyPursuer(survivalWorld,"hull",12,0,{}, {weapon:"automatic"}));
      const heavy=survivalWorld.freeHeavyAiControllerV1.heavy;
      if (heavy.phase==="escape"&&heavy.escapeReason==="hull-danger") {
        escapeHull=survivalBoat.hull;escapeAt=survivalWorld.time;break;
      }
    }
    const survivalHeavy=survivalWorld.freeHeavyAiControllerV1.heavy;
    const initialDistance=Math.hypot(survivalBoat.x-survivalWorld.players[0].x,survivalBoat.y-survivalWorld.players[0].y);
    const shotsBefore=survivalWorld.events.filter(event=>event.type==="heavy-gun-shot").length;
    let maxSpeed=survivalBoat.speed;
    for (let tick=0;tick<160;tick+=1) {
      productionStep(survivalWorld,0.05);
      maxSpeed=Math.max(maxSpeed,survivalBoat.speed);
    }
    const finalDistance=Math.hypot(survivalBoat.x-survivalWorld.players[0].x,survivalBoat.y-survivalWorld.players[0].y);
    const shotsAfter=survivalWorld.events.filter(event=>event.type==="heavy-gun-shot").length;
    const survival={
      escapeHull,escapeAt,phase:survivalHeavy.phase,escapeReason:survivalHeavy.escapeReason,
      maxSpeed,emergencySpeed:controller.emergencyEscapeSpeedV1(survivalBoat),
      initialDistance,finalDistance,coverShots:Math.max(0,shotsAfter-shotsBefore),
      escapeEvents:survivalWorld.events.filter(event=>event.type==="heavy-hull-danger-escape-v1").length,
      destination:survivalHeavy.destination,position:{x:survivalBoat.x,y:survivalBoat.y},
    };
    return {repair,turret,survival};
  });

  assert.deepEqual(browserErrors,[],browserErrors.join("\n"));

  assert.ok(result.repair.completedAt!==null,"the heavy boat never completed repair in Chromium");
  assert.ok(result.repair.phases.includes("escape"),`missing repair escape: ${result.repair.phases.join(" -> ")}`);
  assert.ok(result.repair.phases.includes("stopping"),`missing stopping: ${result.repair.phases.join(" -> ")}`);
  assert.ok(result.repair.phases.includes("repairing"),`missing repairing: ${result.repair.phases.join(" -> ")}`);
  assert.equal(result.repair.repairStops,1,"the repair route must end in one physical stop");
  assert.equal(result.repair.repairStarts,1,"repair must start exactly once");
  assert.equal(result.repair.repairCompletes,1,"repair must complete exactly once");
  assert.equal(result.repair.recoveryStarts,1,"the repaired turret must not be mistaken for a new failure");
  assert.ok(result.repair.turretHealth>0,"turret health was not restored");
  assert.ok(["returning","combat"].includes(result.repair.phase),`unexpected repair phase ${result.repair.phase}`);

  assert.ok(result.turret.windups>0,"the real mounted turret never started aiming in Chromium");
  assert.ok(result.turret.shots>0,"the real mounted turret never fired in Chromium");
  assert.ok(result.turret.fireCooldown<30,"the legacy 999-second turret cooldown was not released");

  assert.ok(result.survival.escapeAt!==null,"predictive survival escape never started in Chromium");
  assert.ok(result.survival.escapeHull>200,`survival escape started too late at ${result.survival.escapeHull}`);
  assert.equal(result.survival.phase,"escape");
  assert.equal(result.survival.escapeReason,"hull-danger");
  assert.equal(result.survival.escapeEvents,1,"survival escape must be announced exactly once");
  assert.ok(result.survival.maxSpeed>=result.survival.emergencySpeed*0.9,`escape speed ${result.survival.maxSpeed} was not maximum ${result.survival.emergencySpeed}`);
  assert.ok(result.survival.finalDistance>result.survival.initialDistance+35,`boat did not physically open distance: ${result.survival.initialDistance} -> ${result.survival.finalDistance}`);
  assert.ok(result.survival.coverShots>0,"the healthy mounted turret did not fire while the boat escaped");

  console.log(JSON.stringify({scenario:"heavy-repair-turret-and-survival",...result},null,2));
} finally {
  await browser.close();
}
