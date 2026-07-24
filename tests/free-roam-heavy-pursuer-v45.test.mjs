import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {activeEnemyBoats, damageEnemyBoat} from "../public/src/free-roam-enemy-boats.js";
import {activeHostileActors, damageHostileActor} from "../public/src/free-roam-hostile-actors.js";
import {
  activeHeavyPursuer,
  damageHeavyPursuer,
  heavyCombatTargets,
} from "../public/src/free-roam-heavy-pursuer.js";
import {startThreatEncounter, updateThreatDirector} from "../public/src/free-roam-threat-director.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function worldForFive(coop = true) {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  if (coop) setPlayerPresence(world, 1, true);
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    player.mode = "boat";
    player.activeBoat = index;
    world.boats[index].driver = index;
    world.boats[index].x = 170 + index * 70;
    world.boats[index].y = 170;
  }
  startThreatEncounter(world, 5, "red-contract");
  return world;
}

function destroyAllExceptHeavy(world) {
  world.freeActivities.marauder.active = false;
  world.freeActivities.marauder.destroyed = true;
  for (const escort of world.freePursuerSquad.escorts) {
    escort.active = false;
    escort.destroyed = true;
  }
  for (const boat of activeEnemyBoats(world)) damageEnemyBoat(world, boat.id, boat.hull, 0);
  for (const actor of activeHostileActors(world)) {
    if (!actor.elite) damageHostileActor(world, actor.id, actor.health, 0, {weapon: "automatic"});
  }
}

test("threat five creates a scaled heavy boat, four escorts in coop and one elite actor", () => {
  const coop = worldForFive(true);
  const heavy = activeHeavyPursuer(coop);
  assert.ok(heavy);
  assert.equal(heavy.maxHull, 340);
  assert.equal(1 + coop.freePursuerSquad.escorts.length + activeEnemyBoats(coop).length, 4);
  const elites = activeHostileActors(coop).filter(actor => actor.elite);
  assert.equal(elites.length, 1);
  assert.equal(elites[0].health, 120);
  assert.equal(elites[0].boatId, heavy.id);

  const solo = worldForFive(false);
  assert.equal(activeHeavyPursuer(solo).maxHull, 285);
  assert.equal(activeEnemyBoats(solo).length, 0);
});

test("heavy hull, turret and engine are separate combat targets", () => {
  const world = worldForFive();
  const targets = heavyCombatTargets(world, 0);
  assert.deepEqual(targets.map(target => target.id), ["heavy-pursuer", "heavy-turret", "heavy-engine"]);
  assert.deepEqual(targets.map(target => target.component), ["hull", "turret", "engine"]);
});

test("pistol cannot pierce heavy armour while automatic fire disables systems", () => {
  const world = worldForFive();
  const heavy = activeHeavyPursuer(world);
  const hull = heavy.hull;
  const turret = heavy.turretHealth;
  const engine = heavy.engineHealth;
  assert.equal(damageHeavyPursuer(world, "hull", 50, 0, {}, {weapon: "pistol"}), false);
  assert.equal(damageHeavyPursuer(world, "turret", 50, 0, {}, {weapon: "pistol"}), false);
  assert.equal(damageHeavyPursuer(world, "engine", 50, 0, {}, {weapon: "pistol"}), false);
  assert.equal(heavy.hull, hull);
  assert.equal(heavy.turretHealth, turret);
  assert.equal(heavy.engineHealth, engine);

  damageHeavyPursuer(world, "turret", 120, 0, {}, {weapon: "automatic"});
  damageHeavyPursuer(world, "engine", 100, 0, {}, {weapon: "automatic"});
  assert.equal(heavy.turretDisabled, true);
  assert.equal(heavy.engineDisabled, true);
});

test("heavy gun announces a windup before producing a finite burst", () => {
  const world = worldForFive(false);
  const heavy = activeHeavyPursuer(world);
  heavy.x = world.boats[0].x + 80;
  heavy.y = world.boats[0].y;
  heavy.turretHeading = -90;
  heavy.fireCooldown = 0;
  run(world, 1.4);
  const types = world.events.map(event => event.type);
  const warningIndex = types.indexOf("heavy-gun-windup");
  const shotIndex = types.indexOf("heavy-gun-shot");
  assert.ok(warningIndex >= 0);
  assert.ok(shotIndex > warningIndex);
  run(world, 2);
  assert.ok(world.freeHeavyPursuer.projectiles.length <= 18);
  assert.ok(world.events.filter(event => event.type === "heavy-gun-shot").length <= 10);
});

test("elite actor is fast but remains slower than the running player and telegraphs knife attacks", () => {
  const world = worldForFive(false);
  const elite = activeHostileActors(world).find(actor => actor.elite);
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 210;
  player.y = 58;
  elite.state = "foot";
  elite.x = 218;
  elite.y = 58;
  elite.targetPlayer = 0;
  elite.targetLockUntil = world.time + 10;
  run(world, 0.1);
  assert.ok(world.events.some(event => event.type === "elite-knife-windup"));

  elite.windupRemaining = 0;
  elite.attackCooldown = 5;
  elite.x = 260;
  const before = elite.x;
  run(world, 1);
  const enemyTravel = before - elite.x;
  assert.ok(enemyTravel <= 11.2, `elite travelled ${enemyTravel}`);
  assert.ok(enemyTravel < 12.5);
});

test("destroyed heavy boat releases its elite into the water", () => {
  const world = worldForFive(false);
  const heavy = activeHeavyPursuer(world);
  const elite = activeHostileActors(world).find(actor => actor.elite);
  assert.equal(elite.state, "aboard");
  damageHeavyPursuer(world, "hull", heavy.hull, 0, {
    onEnemyBoatDestroyed(targetWorld, boat) {
      for (const actor of activeHostileActors(targetWorld)) {
        if (actor.boatId === boat.id && actor.state === "aboard") {
          actor.state = "swim";
          actor.x = boat.x;
          actor.y = boat.y;
        }
      }
    },
  }, {weapon: "automatic"});
  assert.equal(heavy.destroyed, true);
  assert.equal(elite.state, "swim");
  assert.equal(elite.active, true);
});

test("clearing threat five grants 500 credits and six physical loot crates exactly once", () => {
  const world = worldForFive(true);
  world.freeActivities.credits = 25;
  destroyAllExceptHeavy(world);
  const elite = activeHostileActors(world).find(actor => actor.elite);
  damageHostileActor(world, elite.id, elite.health, 0, {weapon: "automatic"});
  const heavy = activeHeavyPursuer(world);
  damageHeavyPursuer(world, "hull", heavy.hull, 0, {}, {weapon: "automatic"});
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 525);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 6);
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 525);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 6);
});
