import test from "node:test";
import assert from "node:assert/strict";
import {
  finishHeavyAiControllerV1,
  moveHeavyToRepairPointV1,
  prepareHeavyAiControllerV1,
  requiredRepairClearanceV1,
  REPAIR_START_CLEARANCE,
} from "../public/src/free-roam-heavy-ai-controller-v1.js";

function makeWorld(player = {x:210,y:200}) {
  const boat={
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:300,y:250,heading:0,turretHeading:0,speed:8,
    hull:260,maxHull:260,engineHealth:180,maxEngineHealth:180,
    turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
    fireCooldown:1,burstRemaining:0,burstCooldown:0,aimRemaining:0,targetPlayer:0,
  };
  return {
    time:100,events:[],
    players:[{...player,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-turret",lastTargetRequestId:"heavy-turret"}}],
    boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-turret"}]},
    freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:1,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

function startDestroyedTurret(world) {
  prepareHeavyAiControllerV1(world);
  const heavy=world.freeHeavyAiControllerV1.heavy;
  heavy.armourBreached=true;
  heavy.phase="combat";
  world.freeHeavyPursuer.boat.turretHealth=0;
  world.freeHeavyPursuer.boat.turretDisabled=true;
  finishHeavyAiControllerV1(world,0.05);
  return heavy;
}

function step(world,seconds=0.05) {
  world.time+=seconds;
  prepareHeavyAiControllerV1(world);
  finishHeavyAiControllerV1(world,seconds);
}

function diagnostic(world,heavy,phases) {
  const boat=world.freeHeavyPursuer.boat;
  return {
    time:world.time,
    phases:[...phases],
    phase:heavy.phase,
    repairSystem:heavy.repairSystem,
    repairProgress:heavy.repairProgress,
    repairRouteClearance:heavy.repairRouteClearance,
    requiredClearance:requiredRepairClearanceV1(heavy),
    repairReroutes:heavy.repairReroutes,
    destination:heavy.destination,
    boat:{x:boat.x,y:boat.y,heading:boat.heading,speed:boat.speed,turretHealth:boat.turretHealth,turretDisabled:boat.turretDisabled},
    player:{x:world.players[0].x,y:world.players[0].y},
    recentEvents:world.events.slice(-12).map(event=>event.type),
  };
}

test("repair safety adapts when fixed 236 metres is geometrically impossible", () => {
  const world=makeWorld();
  const heavy=startDestroyedTurret(world);
  assert.equal(heavy.phase,"escape");
  assert.ok(heavy.repairRouteClearance<REPAIR_START_CLEARANCE,"central player must make fixed 236m impossible");
  assert.ok(requiredRepairClearanceV1(heavy)<=heavy.repairRouteClearance);
  assert.ok(requiredRepairClearanceV1(heavy)>216);
});

test("the real central-map case reaches a stop, repairs once and returns", () => {
  const world=makeWorld();
  const heavy=startDestroyedTurret(world);
  const phases=new Set([heavy.phase]);
  for (let tick=0;tick<1600&&!world.events.some(event=>event.type==="heavy-repair-complete-v1");tick+=1) {
    step(world);
    phases.add(heavy.phase);
  }
  const state=diagnostic(world,heavy,phases);
  console.log("HEAVY_REPAIR_DIAGNOSTIC",JSON.stringify(state));
  assert.ok(phases.has("stopping"),`the boat must physically stop before repair: ${JSON.stringify(state)}`);
  assert.ok(phases.has("repairing"),`the repair phase must be reached: ${JSON.stringify(state)}`);
  assert.equal(world.events.filter(event=>event.type==="heavy-repair-start-v1").length,1);
  assert.equal(world.events.filter(event=>event.type==="heavy-repair-complete-v1").length,1);
  assert.ok(world.freeHeavyPursuer.boat.turretHealth>0);
  assert.ok(["returning","combat"].includes(heavy.phase));
});

test("high-speed repair approach cannot orbit forever outside the six-metre radius", () => {
  const boat={x:0,y:0,heading:90,speed:14.6};
  const destination={x:0,y:8};
  let remaining=Infinity;
  for (let tick=0;tick<240&&remaining>0;tick+=1) remaining=moveHeavyToRepairPointV1(boat,destination,14.6,0.05,78,6);
  assert.equal(remaining,0);
  assert.equal(boat.speed,0);
  assert.deepEqual({x:boat.x,y:boat.y},destination);
});

test("a repaired turret is not mistaken for a newly destroyed turret", () => {
  const world=makeWorld();
  const heavy=startDestroyedTurret(world);
  const phases=new Set([heavy.phase]);
  for (let tick=0;tick<1800&&!world.events.some(event=>event.type==="heavy-repair-complete-v1");tick+=1) {
    step(world);
    phases.add(heavy.phase);
  }
  const state=diagnostic(world,heavy,phases);
  console.log("HEAVY_REPAIR_REPEAT_DIAGNOSTIC",JSON.stringify(state));
  assert.equal(world.events.filter(event=>event.type==="heavy-repair-complete-v1").length,1,JSON.stringify(state));
  for (let tick=0;tick<500;tick+=1) step(world);
  assert.equal(world.events.filter(event=>event.type==="heavy-system-recovery-v1").length,1);
  assert.equal(world.events.filter(event=>event.type==="heavy-repair-complete-v1").length,1);
  assert.ok(world.freeHeavyPursuer.boat.turretHealth>0);
});
