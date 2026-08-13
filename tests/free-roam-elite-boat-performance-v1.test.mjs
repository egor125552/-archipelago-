import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import test from "node:test";
import {createServerFreeRoom,setServerFreePresence,tickServerFreeRoom} from "../src/free-roam-server.js";
import {startEliteBoatBoss} from "../public/src/free-roam-elite-boat.js";

function prepareTwoPlayerBossServer() {
  const server=createServerFreeRoom(1000); setServerFreePresence(server,"captain",true); setServerFreePresence(server,"crew",true); server.world.freeScenario.phase="victory";
  for(let index=0;index<2;index+=1){const player=server.world.players[index]; const boat=server.world.boats[index]; Object.assign(player,{mode:"boat",activeBoat:boat.id}); player.combat.health=100; player.combat.alive=true; Object.assign(boat,{driver:index,owner:index,x:165+index*90,y:195,heading:index?180:0,speed:7}); player.x=boat.x; player.y=boat.y;}
  const boss=startEliteBoatBoss(server.world,501,{x:210,y:175},0); boss.phase="boat-combat"; Object.assign(boss.boat,{x:340,y:190,heading:-90}); for(const turret of boss.boat.turrets) turret.fireCooldown=0; boss.bombCooldown=0; return server;
}

test("two-player elite boss remains bounded at the authoritative 25 Hz tick",t=>{
  const server=prepareTwoPlayerBossServer(); const started=performance.now(); const cpuStarted=process.cpuUsage(); let maximumSnapshotBytes=0,maximumProjectiles=0,maximumBombs=0,maximumEvents=0;
  for(let tick=1;tick<=1500;tick+=1){const snapshot=tickServerFreeRoom(server,1000+tick*40); maximumSnapshotBytes=Math.max(maximumSnapshotBytes,Buffer.byteLength(JSON.stringify(snapshot))); maximumProjectiles=Math.max(maximumProjectiles,server.world.freeEliteBoatBoss?.projectiles?.length||0); maximumBombs=Math.max(maximumBombs,server.world.freeMegaBombs?.projectiles?.length||0); maximumEvents=Math.max(maximumEvents,snapshot.events?.length||0);}
  const elapsed=performance.now()-started; const cpu=process.cpuUsage(cpuStarted); const cpuMs=(cpu.user+cpu.system)/1000; t.diagnostic(`1500 authoritative ticks: ${elapsed.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms CPU; max snapshot ${maximumSnapshotBytes} bytes; bullets ${maximumProjectiles}; bombs ${maximumBombs}; events ${maximumEvents}`);
  assert.ok(maximumProjectiles<=96); assert.ok(maximumBombs<=8); assert.ok(maximumEvents<=40); assert.ok(maximumSnapshotBytes<90000); assert.ok(cpuMs<15000,"a 60-second simulation must remain at least four times faster than real time");
});
