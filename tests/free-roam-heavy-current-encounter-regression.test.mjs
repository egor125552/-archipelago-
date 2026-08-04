import test from "node:test";
import assert from "node:assert/strict";

import {prepareHeavyAiControllerV1} from "../public/src/free-roam-heavy-ai-controller-v1.js";

function makeWorldWithFreshHeavyAndStaleController() {
  const boat = {
    id:"heavy-pursuer",role:"heavy",active:true,destroyed:false,
    x:172.168,y:300,heading:0,turretHeading:0,speed:0,
    hull:700,maxHull:700,engineHealth:180,maxEngineHealth:180,
    turretHealth:240,maxTurretHealth:240,engineDisabled:false,turretDisabled:false,
    fireCooldown:1,burstRemaining:0,burstCooldown:0,aimRemaining:0,targetPlayer:0,
  };
  return {
    time:10908.96,
    events:[{
      type:"heavy-pursuer-arrived",
      text:"Угроза пять из пяти. В бухту вошёл тяжёлый катер.",
      targets:[0,1],
      at:10908.96,
      operationEvent:true,
      x:boat.x,
      y:boat.y,
      hull:boat.hull,
    }],
    players:[{
      x:54.168,y:276.267,heading:0,mode:"boat",activeBoat:0,
      combat:{alive:true,equipped:"automatic",lockedTargetId:null},
    }],
    boats:[{id:0,x:54.168,y:276.267,active:true,destroyed:false,hull:0.05}],
    freeActivities:{presence:[true],inputs:[{}]},
    freeThreatDirector:{
      active:true,level:5,encounterId:19,heavyStarted:true,heavyStartsAt:0,
      assignments:{"heavy-pursuer":0},
    },
    freeHeavyPursuer:{
      active:true,encounterId:19,boat,projectiles:[],nextProjectileId:1,
    },
    freeHeavyAiControllerV1:{
      heavy:{
        encounterId:18,phase:"combat",armourBreached:false,armourMax:700,coreMax:260,
        repairPlates:3,repairSystem:null,repairProgress:0,repairQuarter:0,
        destination:null,combatPoint:{x:280,y:220},lastDamageAt:-999,
      },
      encounterId:18,frame:null,serial:0,targetLocks:{},automaticHits:[],lastWindupAt:-999,
    },
    freeCombatAiV164:{
      heavyEncounterId:18,
      heavy:{encounterId:18,phase:"combat"},
    },
    freeHostileActors:{actors:[],projectiles:[]},
    freeHostileGunners:{gunners:[],projectiles:[]},
    freePursuerSquad:{escorts:[],projectiles:[]},
    freeEnemyBoats:{boats:[],projectiles:[]},
    freeMegaBombs:{projectiles:[]},
  };
}

test("a freshly spawned current-encounter heavy is never retired because the controller cache is stale", () => {
  const world=makeWorldWithFreshHeavyAndStaleController();
  const newBoat=world.freeHeavyPursuer.boat;

  prepareHeavyAiControllerV1(world);

  assert.equal(world.freeHeavyPursuer.boat,newBoat);
  assert.equal(world.freeHeavyPursuer.active,true);
  assert.equal(world.freeHeavyPursuer.encounterId,19);
  assert.equal(world.freeHeavyAiControllerV1.encounterId,19);
  assert.equal(world.freeHeavyAiControllerV1.heavy.encounterId,19);
  assert.equal(world.freeHeavyAiControllerV1.heavy.phase,"approach");
  assert.equal(world.events.some(event=>event.type==="heavy-stale-state-retired-v1"),false);
  assert.equal(world.events.some(event=>event.type==="heavy-pursuer-approaching"),true);
});
