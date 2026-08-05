"use strict";

import {createFreeWorld, setPlayerPresence} from "./free-roam-core-v6.js";
import {
  damageEliteBoatBoss,
  eliteBossCombatTargets,
  startEliteBoatBoss,
  updateEliteBoatBoss,
} from "./free-roam-elite-boat.js";
import {activeHostileActors, damageHostileActor} from "./free-roam-hostile-actors.js";
import {replicatedFreeWorld} from "./free-roam-replication.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  world.freeThreatDirector ||= {graceUntil: [0, 0]};
  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, true);
  for (let index = 0; index < 2; index += 1) {
    const player = world.players[index];
    player.mode = "boat";
    player.activeBoat = index;
    world.boats[index].driver = index;
    world.boats[index].owner = index;
    world.boats[index].x = 175 + index * 55;
    world.boats[index].y = 180;
    player.x = world.boats[index].x;
    player.y = world.boats[index].y;
  }

  const state = startEliteBoatBoss(world, 77, {x: 205, y: 180}, 0);
  state.phase = "boat-combat";
  Object.assign(state.boat, {x: 305, y: 180, heading: -90, speed: 0});
  for (const turret of state.boat.turrets) turret.fireCooldown = 0;

  const initialTargets = eliteBossCombatTargets(world, 0).map(target => target.id);
  for (let tick = 0; tick < 50; tick += 1) updateEliteBoatBoss(world, 0.04, {});
  const turretShots = world.events.filter(event => event.type === "elite-turret-shot");
  const shotTurrets = [...new Set(turretShots.map(event => event.turretId))].sort();
  const aimSections = [...new Set(turretShots.map(event => event.aimSection))].sort();
  const launchPoints = new Map();
  for (const shot of turretShots) if (!launchPoints.has(shot.turretId)) launchPoints.set(shot.turretId, {x: shot.x, y: shot.y});

  damageEliteBoatBoss(world, "turret-port", 520, 0, {weapon: "automatic"});
  const shotsBefore = world.events.filter(event => event.type === "elite-turret-shot" && event.turretId === "elite-turret-starboard").length;
  for (let tick = 0; tick < 120; tick += 1) updateEliteBoatBoss(world, 0.04, {});
  const shotsAfter = world.events.filter(event => event.type === "elite-turret-shot" && event.turretId === "elite-turret-starboard").length;

  for (const layer of ["outer", "middle", "inner"]) damageEliteBoatBoss(world, `armor-${layer}`, 1000, 0, {weapon: "automatic"});
  const hullTarget = eliteBossCombatTargets(world, 0)[0]?.id;
  damageEliteBoatBoss(world, "hull", 5000, 0, {weapon: "automatic"});
  for (let tick = 0; tick < 50; tick += 1) updateEliteBoatBoss(world, 0.04, {});
  const commanders = activeHostileActors(world).filter(actor => actor.commander);
  const commander = commanders[0];
  const phaseBeforeCommanderDeath = state.phase;
  if (commander) damageHostileActor(world, commander.id, 800, 0, {weapon: "mega-bomb"});
  updateEliteBoatBoss(world, 0.04, {});

  const left = replicatedFreeWorld(world, 0);
  const right = replicatedFreeWorld(world, 1);
  const points = [...launchPoints.values()];
  const result = {
    version: state.version,
    initialTargets,
    shotTurrets,
    aimSections,
    distinctLaunchPoints: points.length === 2 && (points[0].x !== points[1].x || points[0].y !== points[1].y),
    starboardContinued: shotsAfter > shotsBefore,
    portDestroyed: state.boat.turrets[0].destroyed,
    starboardDestroyed: state.boat.turrets[1].destroyed,
    armor: state.boat.armorLayers.map(layer => layer.hp),
    hullTarget,
    phaseBeforeCommanderDeath,
    commanderCount: commanders.length,
    commanderId: commander?.id || null,
    finalPhase: state.phase,
    completionEvents: world.events.filter(event => event.type === "elite-boss-completed").length,
    replicasEqual: JSON.stringify(left.freeEliteBoatBoss) === JSON.stringify(right.freeEliteBoatBoss),
  };

  assert(result.version === "1.1.0", "wrong subsystem version");
  assert(JSON.stringify(result.initialTargets) === JSON.stringify(["elite-armor-outer", "elite-turret-port", "elite-turret-starboard"]), "wrong initial targets");
  assert(JSON.stringify(result.shotTurrets) === JSON.stringify(["elite-turret-port", "elite-turret-starboard"]), "both turrets did not fire");
  assert(JSON.stringify(result.aimSections) === JSON.stringify(["front", "rear"]), "turrets did not bracket front and rear halves");
  assert(result.distinctLaunchPoints, "turrets share one fake launch point");
  assert(result.portDestroyed && !result.starboardDestroyed && result.starboardContinued, "turret lifecycles are coupled");
  assert(result.armor.every(value => value === 0) && result.hullTarget === "elite-hull", "armor did not open hull sequentially");
  assert(result.phaseBeforeCommanderDeath === "commander-combat" && result.commanderCount === 1, "commander deployment is invalid");
  assert(result.finalPhase === "completed" && result.completionEvents === 1, "encounter did not finish exactly once");
  assert(result.replicasEqual, "clients received different boss state");
  return result;
}

const status = document.getElementById("status");
const output = document.getElementById("result");
run().then(result => {
  status.textContent = `Проверка завершена. Фаза ${result.finalPhase}.`;
  output.textContent = JSON.stringify({ok: true, ...result});
  document.body.dataset.ready = "true";
}).catch(error => {
  status.textContent = `Ошибка проверки: ${error.message}`;
  output.textContent = JSON.stringify({ok: false, error: String(error?.stack || error)});
  document.body.dataset.ready = "error";
  console.error(error);
});
