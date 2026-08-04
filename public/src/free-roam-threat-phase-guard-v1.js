"use strict";

import {values} from "./free-roam-heavy-ai-support-v1.js?v=1";

export function rollbackPrematureThreatPhasesV1(world,start=0) {
  const director=world.freeThreatDirector,intelligence=world.freeThreatIntelligence;
  if (!director?.active||Number(director.level)<5||director.heavyStarted||!intelligence) return false;
  if (!intelligence.phase2Spawned&&!intelligence.finalWaveSpawned&&Number(intelligence.phase)<=1) return false;
  const encounter=String(director.encounterId??"");
  const belongs=item=>{const id=String(item?.id||"");return id.startsWith(`threat-reinforcement-${encounter}-2-`)||id.startsWith(`threat-reinforcement-${encounter}-3-`)||id.startsWith(`threat-phase-${encounter}-2-`)||id.startsWith(`threat-phase-${encounter}-3-`);};
  const removedBoats=new Set(values(world.freeEnemyBoats?.boats).filter(belongs).map(boat=>String(boat.id)));
  if (world.freeEnemyBoats?.boats) world.freeEnemyBoats.boats=values(world.freeEnemyBoats.boats).filter(item=>!belongs(item));
  if (director.boats) director.boats=values(director.boats).filter(item=>!belongs(item));
  const removedActors=new Set();
  if (world.freeHostileActors?.actors) world.freeHostileActors.actors=values(world.freeHostileActors.actors).filter(actor=>{const remove=belongs(actor)||removedBoats.has(String(actor?.boatId||""));if(remove)removedActors.add(String(actor?.id||""));return !remove;});
  if (world.freeHostileActors?.projectiles) world.freeHostileActors.projectiles=values(world.freeHostileActors.projectiles).filter(projectile=>!removedActors.has(String(projectile?.sourceActorId??projectile?.ownerId??""))&&!removedBoats.has(String(projectile?.sourceBoatId??projectile?.boatId??"")));
  if (world.freeEnemyBoats?.projectiles) world.freeEnemyBoats.projectiles=values(world.freeEnemyBoats.projectiles).filter(projectile=>!removedBoats.has(String(projectile?.sourcePursuerId??projectile?.sourceBoatId??projectile?.boatId??"")));
  if (director.assignments) for (const id of removedBoats) delete director.assignments[id];
  Object.assign(intelligence,{encounterId:Number(director.encounterId)||0,phase:1,phase2StartedAt:0,phase2BaselineActors:0,phase2Spawned:false,finalWaveSpawned:false,nextBoatSerial:1});
  world.events=values(world.events).filter((event,index)=>index<start||!["contract-threat-phase-two","contract-threat-final-wave","contract-threat-final-phase"].includes(event.type));
  return true;
}
