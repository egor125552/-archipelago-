import test from "node:test";
import assert from "node:assert/strict";
import {prepareHeavyAiControllerV1,finishHeavyAiControllerV1} from "../public/src/free-roam-heavy-ai-controller-v1.js";
import {normalizeHeavyBaseStepV1} from "../public/src/free-roam-heavy-ai-base-normalizer-v1.js";

function makeWorld() {
  const boat={
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:300,y:250,heading:0,speed:8,hull:700,maxHull:700,
    engineHealth:180,maxEngineHealth:180,turretHealth:240,maxTurretHealth:240,
    engineDisabled:false,turretDisabled:false,fireCooldown:1,burstRemaining:0,aimRemaining:0,targetPlayer:0,
  };
  return {
    time:100,events:[],players:[{x:30,y:30,mode:"foot",combat:{alive:true}}],boats:[],
    freeActivities:{presence:[true],inputs:[{}]},
    freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:true,assignments:{"heavy-pursuer":0}},
    freeHeavyPursuer:{active:true,encounterId:1,boat,projectiles:[],nextProjectileId:1},
    freeHostileActors:{actors:[],projectiles:[]},freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},freeEnemyBoats:{boats:[],projectiles:[]},freeMegaBombs:{projectiles:[]},
  };
}

test("destroyed armour becomes the internal hull instead of deleting the heavy boat",()=>{
  const world=makeWorld();
  prepareHeavyAiControllerV1(world);
  const boat=world.freeHeavyPursuer.boat;
  boat.hull=0;boat.active=false;boat.destroyed=true;
  world.freeHeavyPursuer.active=false;
  world.events.push({type:"heavy-pursuer-destroyed",at:world.time,targets:[0]});

  assert.equal(normalizeHeavyBaseStepV1(world),true);
  finishHeavyAiControllerV1(world,0);

  const heavy=world.freeHeavyAiControllerV1.heavy;
  assert.equal(world.freeHeavyPursuer.boat,boat);
  assert.equal(heavy.armourBreached,true);
  assert.equal(boat.active,true);
  assert.equal(boat.destroyed,false);
  assert.equal(boat.hull,260);
  assert.equal(world.events.some(event=>event.type==="heavy-armour-breached"),true);
});

test("movement performed by the base layer is discarded before the owner controller runs",()=>{
  const world=makeWorld();
  prepareHeavyAiControllerV1(world);
  const boat=world.freeHeavyPursuer.boat;
  boat.x=355;boat.y=295;boat.heading=120;boat.speed=17;

  assert.equal(normalizeHeavyBaseStepV1(world),true);
  assert.equal(boat.x,300);
  assert.equal(boat.y,250);
  assert.equal(boat.heading,0);
  assert.equal(boat.speed,8);

  finishHeavyAiControllerV1(world,0);
  assert.equal(boat.x,300);
  assert.equal(boat.y,250);
});
