import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {activeEnemyBoats, damageEnemyBoat} from "../public/src/free-roam-enemy-boats.js";
import {activeHostileActors, damageHostileActor} from "../public/src/free-roam-hostile-actors.js";
import {damageEliteBoatBoss, ensureEliteBoatBoss, updateEliteBoatBoss} from "../public/src/free-roam-elite-boat.js";
import {
  activeHeavyPursuer,
  damageHeavyPursuer,
  heavyCombatTargets,
} from "../public/src/free-roam-heavy-pursuer.js";
import {notifyThreatBoatDestroyed, startThreatEncounter, updateThreatDirector} from "../public/src/free-roam-threat-director.js";

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
  world.time = world.freeThreatDirector.heavyStartsAt;
  updateThreatDirector(world);
  return world;
}

function placeAttackerNearHeavy(world, metres = 35) {
  const heavy = activeHeavyPursuer(world);
  const player = world.players[0];
  const boat = world.boats[player.activeBoat];
  boat.x = heavy.x - metres;
  boat.y = heavy.y;
  player.x = boat.x;
  player.y = boat.y;
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

test("threat five creates the heavy boat first and does not preload the separate boss", () => {
  const coop = worldForFive(true);
  const heavy = activeHeavyPursuer(coop);
  assert.ok(heavy);
  assert.equal(heavy.maxHull, 1000);
  assert.equal(1 + coop.freePursuerSquad.escorts.length + activeEnemyBoats(coop).length, 4);
  assert.equal(activeHostileActors(coop).some(actor => actor.elite), false);
  assert.equal(ensureEliteBoatBoss(coop).active, false);

  const solo = worldForFive(false);
  assert.equal(activeHeavyPursuer(solo).maxHull, 700);
  assert.equal(activeEnemyBoats(solo).length, 0);
});

test("heavy hull, turret and engine are separate combat targets", () => {
  const world = worldForFive();
  const targets = heavyCombatTargets(world, 0);
  assert.deepEqual(targets.map(target => target.id), ["heavy-pursuer", "heavy-turret", "heavy-engine"]);
  assert.deepEqual(targets.map(target => target.component), ["hull", "turret", "engine"]);
});

test("pistol cannot pierce heavy armour while close automatic fire disables systems", () => {
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

  placeAttackerNearHeavy(world);
  damageHeavyPursuer(world, "turret", 240, 0, {}, {weapon: "automatic"});
  damageHeavyPursuer(world, "engine", 180, 0, {}, {weapon: "automatic"});
  assert.equal(heavy.turretDisabled, true);
  assert.equal(heavy.engineDisabled, true);
  assert.deepEqual(heavyCombatTargets(world, 0).map(target => target.id), ["heavy-pursuer"]);
});

test("heavy gun announces a windup before producing a long finite barrage", () => {
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
  run(world, 3.2);
  const shots = world.events.filter(event => event.type === "heavy-gun-shot").length;
  assert.ok(world.freeHeavyPursuer.projectiles.length <= 48);
  assert.ok(shots >= 20, `expected a sustained barrage, got ${shots} shots`);
  assert.ok(shots <= 28, `a finite barrage must stop at 28 shots, got ${shots}`);
});

test("destroying the heavy boat starts the separate three-layer elite boss", () => {
  const world = worldForFive(false);
  const heavy = activeHeavyPursuer(world);
  heavy.active = false;
  heavy.destroyed = true;
  notifyThreatBoatDestroyed(world, heavy, 0);
  const boss = ensureEliteBoatBoss(world);
  assert.equal(boss.active, true);
  assert.equal(boss.boat.armorLayers.length, 3);
  assert.equal(boss.boat.armorLayers.every(layer => layer.hp === 1000), true);
  assert.equal(activeHostileActors(world).some(actor => actor.commander), false);
});

test("destroyed heavy boat does not release the old attached elite actor", () => {
  const world = worldForFive(false);
  const heavy = activeHeavyPursuer(world);
  heavy.active = false;
  heavy.destroyed = true;
  notifyThreatBoatDestroyed(world, heavy, 0);
  assert.equal(activeHostileActors(world).some(actor => actor.id.startsWith("elite-") && !actor.commander), false);
  assert.equal(ensureEliteBoatBoss(world).active, true);
});

test("threat five rewards only after the elite commander is defeated, exactly once", () => {
  const world = worldForFive(true);
  world.freeActivities.credits = 25;
  destroyAllExceptHeavy(world);
  const heavy = activeHeavyPursuer(world);
  heavy.active = false;
  heavy.destroyed = true;
  notifyThreatBoatDestroyed(world, heavy, 0);
  const boss = ensureEliteBoatBoss(world);
  boss.phase = "boat-combat";
  for (const layer of ["outer", "middle", "inner"]) damageEliteBoatBoss(world, `armor-${layer}`, 1000, 0, {weapon: "automatic"});
  damageEliteBoatBoss(world, "hull", 5000, 0, {weapon: "automatic"});
  for (let index = 0; index < 50; index += 1) updateEliteBoatBoss(world, 0.04, {});
  assert.equal(world.freeActivities.credits, 25, "the ship alone must not award victory");
  const commander = activeHostileActors(world).find(actor => actor.commander);
  assert.ok(commander);
  damageHostileActor(world, commander.id, commander.health + commander.armor, 0, {weapon: "automatic"});
  updateEliteBoatBoss(world, 0.04, {});
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 525);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 6);
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 525);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 6);
});
