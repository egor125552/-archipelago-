import test from "node:test";
import assert from "node:assert/strict";
import {rollbackPrematureThreatPhasesV1} from "../public/src/free-roam-threat-phase-guard-v1.js";

test("premature phase-two forces are removed before the heavy phase starts", () => {
  const world={
    events:[{type:"contract-threat-start"},{type:"contract-threat-phase-two"},{type:"contract-threat-final-wave"}],
    freeThreatDirector:{active:true,level:5,encounterId:1,heavyStarted:false,boats:[{id:"opening"},{id:"threat-reinforcement-1-2-1"}],assignments:{opening:0,"threat-reinforcement-1-2-1":0}},
    freeThreatIntelligence:{encounterId:1,phase:3,phase2Spawned:true,finalWaveSpawned:true},
    freeEnemyBoats:{boats:[{id:"opening"},{id:"threat-reinforcement-1-2-1"}],projectiles:[]},
    freeHostileActors:{actors:[{id:"opening-actor",boatId:"opening"},{id:"threat-phase-1-2-1",boatId:"threat-reinforcement-1-2-1"}],projectiles:[]},
  };
  assert.equal(rollbackPrematureThreatPhasesV1(world,0),true);
  assert.deepEqual(world.freeEnemyBoats.boats.map(boat=>boat.id),["opening"]);
  assert.deepEqual(world.freeHostileActors.actors.map(actor=>actor.id),["opening-actor"]);
  assert.equal(world.freeThreatIntelligence.phase,1);
  assert.equal(world.events.some(event=>event.type==="contract-threat-final-wave"),false);
});
