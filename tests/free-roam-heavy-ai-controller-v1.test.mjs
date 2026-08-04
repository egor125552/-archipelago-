import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareHeavyAiControllerV1,
  finishHeavyAiControllerV1,
  normalizeHeavyPhaseV1,
} from "../public/src/free-roam-heavy-ai-controller-v1.js";
import {
  preserveHeavyTargetLocks as preserveHeavyTargetLocksV1,
  retireStaleHeavyV1,
} from "../public/src/free-roam-heavy-ai-support-v1.js";

function makeWorld() {
  const boat = {
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,x:300,y:250,heading:0,turretHeading:0,speed:8,
    hull:260,maxHull:260,engineHealth:180,maxEngineHealth:180,turretHealth:240,maxTurretHealth:240,
    engineDisabled:false,turretDisabled:false,fireCooldown:1,burstRemaining:0,burstCooldown:0,aimRemaining:0,targetPlayer:0,
  };
  return {
    time:100,events:[],players:[{x:30,y:30,heading:0,mode:"foot",combat:{alive:true,equipped:"automatic",lockedTargetId:"heavy-turret",lastTargetRequestId:"heavy-turret"}}],
    boats:[],freeActivities:{presence:[true],inputs:[{targetId:"heavy-turret"}]},
    freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:true,heavyStartsAt:0,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:1,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

test("authoritative hotfix imports one heavy controller and no V164-V176 chain", async () => {
  const fs=await import("node:fs/promises");
  const hotfix=await fs.readFile(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js",import.meta.url),"utf8");
  const controller=await fs.readFile(new URL("../public/src/free-roam-heavy-ai-controller-v1.js",import.meta.url),"utf8");
  assert.match(hotfix,/free-roam-heavy-ai-controller-v1\.js\?v=1/);
  assert.match(hotfix,/prepareHeavyAiControllerV1\(world\)/);
  assert.match(hotfix,/finishHeavyAiControllerV1\(world,dt\)/);
  assert.doesNotMatch(hotfix,/free-roam-combat-ai-model-v1(?:6[4-9]|7[0-6])\.js/);
  assert.doesNotMatch(controller,/from\s+["']\.\/free-roam-combat-ai-model-v1(?:6[4-9]|7[0-6])\.js/);
});

test("old repair phases migrate into the single canonical state machine", () => {
  for (const [legacy,expected] of [["retreating","escape"],["breach-escaping-v166","escape"],["stopping-v165","stopping"],["breach-repairing-v166","repairing"],["breach-returning-v166","returning"]]) {
    const heavy={phase:legacy};assert.equal(normalizeHeavyPhaseV1(heavy),expected);assert.equal(heavy.phase,expected);
  }
});

test("destroyed turret starts one repair escape", () => {
  const world=makeWorld();prepareHeavyAiControllerV1(world);const heavy=world.freeHeavyAiControllerV1.heavy;
  heavy.armourBreached=true;heavy.phase="combat";world.freeHeavyPursuer.boat.turretHealth=0;world.freeHeavyPursuer.boat.turretDisabled=true;
  finishHeavyAiControllerV1(world,0.1);
  assert.equal(heavy.phase,"escape");assert.equal(heavy.escapeReason,"repair");assert.equal(heavy.repairSystem,"turret");assert.ok(heavy.destination);
  assert.equal(world.events.filter(event=>event.type==="heavy-system-recovery-v1").length,1);
});

test("a close player aborts turret repair and no later layer resurrects it", () => {
  const world=makeWorld();prepareHeavyAiControllerV1(world);const heavy=world.freeHeavyAiControllerV1.heavy;
  Object.assign(heavy,{armourBreached:true,phase:"repairing",repairSystem:"turret",repairPlates:2,repairProgress:6});
  Object.assign(world.freeHeavyPursuer.boat,{turretHealth:0,turretDisabled:true,x:150,y:150});Object.assign(world.players[0],{x:155,y:150});
  finishHeavyAiControllerV1(world,0.1);
  assert.equal(heavy.phase,"escape");assert.equal(world.events.filter(event=>event.type==="heavy-repair-aborted-v1").length,1);
  world.time+=0.1;prepareHeavyAiControllerV1(world);finishHeavyAiControllerV1(world,0.1);
  assert.equal(heavy.phase,"escape");assert.equal(world.events.filter(event=>event.type==="heavy-repair-start-v1").length,0);
});

test("engine destruction during an escape always takes priority and stops the boat", () => {
  const world=makeWorld();prepareHeavyAiControllerV1(world);const heavy=world.freeHeavyAiControllerV1.heavy;
  Object.assign(heavy,{armourBreached:true,phase:"escape",escapeReason:"repair",repairSystem:"turret",destination:{x:404,y:308}});
  Object.assign(world.freeHeavyPursuer.boat,{turretHealth:0,engineHealth:0,engineDisabled:true});finishHeavyAiControllerV1(world,0.1);
  assert.equal(heavy.phase,"stopping");assert.equal(heavy.repairSystem,"engine");
});

test("a living heavy target remains locked for a long-range mega-bomb", () => {
  const world=makeWorld();Object.assign(world.players[0],{x:20,y:20});Object.assign(world.freeHeavyPursuer.boat,{x:250,y:180});
  prepareHeavyAiControllerV1(world);const state=world.freeHeavyAiControllerV1,eventStart=world.events.length;
  world.events.push({type:"target-cleared",targets:[0],at:world.time});preserveHeavyTargetLocksV1(world,state,eventStart);
  assert.equal(world.players[0].combat.lockedTargetId,"heavy-turret");assert.equal(world.events.some(event=>event.type==="target-cleared"),false);
  assert.equal(world.events.some(event=>event.type==="target-locked-long-range-v1"),true);
});

test("an old heavy from another encounter is removed with crew, shots and locks", () => {
  const world=makeWorld();prepareHeavyAiControllerV1(world);
  world.freeHostileActors.actors.push({id:"old-heavy-crew",boatId:"heavy-pursuer",active:true});world.freeHeavyPursuer.projectiles.push({id:"old-heavy-shot"});world.freeThreatDirector.encounterId=2;
  assert.equal(retireStaleHeavyV1(world),true);assert.equal(world.freeHeavyPursuer.boat,null);assert.deepEqual(world.freeHeavyPursuer.projectiles,[]);
  assert.equal(world.freeHostileActors.actors.some(actor=>actor.id==="old-heavy-crew"),false);assert.equal(world.players[0].combat.lockedTargetId,null);
});

test("a due heavy phase adopts the damaged boat instead of spawning a fresh one", () => {
  const world=makeWorld();world.freeThreatDirector.heavyStarted=false;world.freeThreatDirector.heavyStartsAt=100.04;world.freeHeavyPursuer.encounterId=11;
  world.freeCombatAiV164={heavyEncounterId:11,heavy:{encounterId:11,phase:"repairing",armourBreached:true,coreMax:260,repairPlates:2,repairSystem:"turret",repairProgress:4,destination:{x:404,y:308},combatPoint:{x:280,y:220},lastDamageAt:90}};
  world.freeHeavyPursuer.boat.hull=218;world.freeHeavyPursuer.boat.turretHealth=0;prepareHeavyAiControllerV1(world);
  assert.equal(world.freeThreatDirector.heavyStarted,true);assert.equal(world.freeHeavyPursuer.boat.hull,218);
  assert.equal(world.freeHeavyAiControllerV1.heavy.repairProgress,4);assert.equal(world.freeHeavyAiControllerV1.heavy.phase,"repairing");
  assert.ok(world.freeHostileActors.actors.some(actor=>actor.id==="elite-1"));
});

test("a duplicate heavy spawned during the step is replaced by the damaged original", () => {
  const world=makeWorld(),original=world.freeHeavyPursuer.boat;original.hull=218;original.turretHealth=0;
  world.freeHeavyPursuer.projectiles=[{id:"old-shot"}];world.freeHeavyPursuer.nextProjectileId=8;prepareHeavyAiControllerV1(world);
  world.freeHeavyPursuer.boat={...original,hull:700,turretHealth:240,x:150,y:240};world.events.push({type:"heavy-pursuer-arrived",at:world.time});
  finishHeavyAiControllerV1(world,0.1);
  assert.equal(world.freeHeavyPursuer.boat,original);assert.equal(original.hull,218);assert.ok(Math.abs(original.x-300)<1);
  assert.deepEqual(world.freeHeavyPursuer.projectiles,[{id:"old-shot"}]);assert.ok(world.events.some(event=>event.type==="heavy-pursuer-continuity-restored-v1"));
});
