import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerInput, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {activeEnemyBoats, damageEnemyBoat} from "../public/src/free-roam-enemy-boats.js";
import {
  activeHostileActors,
  damageHostileActor,
  releaseCrewFromBoat,
  updateHostileActors,
} from "../public/src/free-roam-hostile-actors.js";
import {createTargetMenu} from "../public/src/free-roam-target-menu.js";
import {
  cancelThreatEncounter,
  startThreatEncounter,
  updateThreatDirector,
} from "../public/src/free-roam-threat-director.js";

function run(world, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function twoPlayerWorld() {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 1, true);
  for (let index = 0; index < 2; index += 1) {
    const player = world.players[index];
    player.mode = "foot";
    player.activeBoat = null;
    player.x = 185 + index * 50;
    player.y = 58;
  }
  return world;
}

function destroyBaseSquad(world) {
  const primary = world.freeActivities.marauder;
  primary.active = false;
  primary.destroyed = true;
  primary.hull = 0;
  for (const escort of world.freePursuerSquad.escorts) {
    escort.active = false;
    escort.destroyed = true;
    escort.hull = 0;
  }
}

test("threat three creates three distinct tactical boats and physical crews", () => {
  const world = twoPlayerWorld();
  startThreatEncounter(world, 3, "contract-three");
  assert.equal(world.freePursuerSquad.escorts.length + 1 + activeEnemyBoats(world).length, 3);
  assert.equal(world.freePursuerSquad.escorts.length, 1);
  assert.equal(activeEnemyBoats(world)[0].role, "interceptor");
  assert.equal(activeHostileActors(world).length, 3);
  assert.ok(activeHostileActors(world).some(actor => actor.weapon === "pistol"));
  assert.ok(activeHostileActors(world).some(actor => actor.weapon === "automatic"));
});

test("threat four creates six boats, six actors and distributes pressure across both players", () => {
  const world = twoPlayerWorld();
  startThreatEncounter(world, 4, "contract-four");
  const boats = [world.freeActivities.marauder, ...world.freePursuerSquad.escorts, ...activeEnemyBoats(world)];
  assert.equal(boats.length, 6);
  assert.equal(activeHostileActors(world).length, 6);
  assert.deepEqual(new Set(activeEnemyBoats(world).map(boat => boat.role)), new Set(["rammer", "gunboat"]));
  const counts = [0, 0];
  for (const target of Object.values(world.freeThreatDirector.assignments)) counts[target] += 1;
  assert.ok(counts[0] > 0 && counts[1] > 0);
  assert.ok(Math.max(...counts) <= Math.ceil(boats.length * 0.65));
});

test("physical crew disembarks, swims after its boat is destroyed and can board another boat", () => {
  const world = twoPlayerWorld();
  startThreatEncounter(world, 3, "crew-cycle");
  const actor = activeHostileActors(world)[0];
  const sourceBoat = [world.freeActivities.marauder, ...world.freePursuerSquad.escorts, ...activeEnemyBoats(world)]
    .find(boat => boat.id === actor.boatId);
  world.players[actor.targetPlayer].mode = "foot";
  world.players[actor.targetPlayer].x = sourceBoat.x;
  world.players[actor.targetPlayer].y = 58;
  sourceBoat.y = 78;
  updateHostileActors(world, 0.1);
  assert.equal(actor.state, "disembarking");
  run(world, 1);
  assert.equal(actor.state, "foot");

  actor.state = "aboard";
  actor.boatId = sourceBoat.id;
  releaseCrewFromBoat(world, sourceBoat);
  assert.equal(actor.state, "swim");
  const destination = [world.freeActivities.marauder, ...world.freePursuerSquad.escorts, ...activeEnemyBoats(world)]
    .find(boat => boat.id !== sourceBoat.id && boat.active && !boat.destroyed);
  actor.x = destination.x;
  actor.y = destination.y;
  updateHostileActors(world, 0.1);
  assert.equal(actor.state, "boarding");
  updateHostileActors(world, 0.8);
  assert.equal(actor.state, "aboard");
  assert.equal(actor.boatId, destination.id);
});

test("knife, pistol and automatic routes all damage physical enemies", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  const player = world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 210;
  player.y = 58;
  startThreatEncounter(world, 3, "weapons");
  const actors = activeHostileActors(world);

  const pistolTarget = actors[0];
  pistolTarget.state = "foot";
  pistolTarget.x = 212;
  pistolTarget.y = 58;
  const pistolBefore = pistolTarget.health;
  player.combat.equipped = "pistol";
  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {});
  stepFreeWorld(world, 0.05);
  assert.ok(pistolTarget.health < pistolBefore);

  const knifeTarget = actors.find(actor => actor.active && actor !== pistolTarget);
  knifeTarget.state = "foot";
  knifeTarget.x = 211;
  knifeTarget.y = 58;
  for (const other of actors) if (other !== knifeTarget) other.x = 400;
  player.combat.weapons.knife = true;
  player.combat.equipped = "knife";
  const knifeBefore = knifeTarget.health;
  setPlayerInput(world, 0, {attack: true});
  run(world, 0.25);
  setPlayerInput(world, 0, {});
  stepFreeWorld(world, 0.05);
  assert.ok(knifeTarget.health < knifeBefore);

  const automaticTarget = actors.find(actor => actor.active && actor !== knifeTarget);
  automaticTarget.state = "foot";
  automaticTarget.x = 212;
  automaticTarget.y = 58;
  for (const other of actors) if (other !== automaticTarget) other.x = 400;
  player.combat.weapons.automatic = true;
  player.combat.ammo = 20;
  player.combat.equipped = "automatic";
  player.combat.attackCooldown = 0;
  const automaticBefore = automaticTarget.health;
  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {});
  stepFreeWorld(world, 0.05);
  assert.ok(automaticTarget.health < automaticBefore);
});

test("combat target menu hides navigation entries during an active encounter", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  startThreatEncounter(world, 3, "combat-menu");
  const menu = createTargetMenu({
    getWorld: () => world,
    getPlayerIndex: () => 0,
    getTargetId: () => null,
    setTargetId: () => {},
    getNavigationTargetId: () => "merchant",
    setNavigationTargetId: () => {},
    releaseMovement: () => {},
    sendInput: () => {},
    announce: () => {},
    render: () => {},
  });
  menu.open();
  const snapshot = menu.snapshot();
  assert.ok(snapshot.targets.length > 0);
  assert.equal(snapshot.targets.some(id => id.startsWith("navigation-")), false);
});

test("clearing threat four grants one battle reward and four physical loot crates", () => {
  const world = twoPlayerWorld();
  world.freeActivities.credits = 10;
  startThreatEncounter(world, 4, "reward-four");
  destroyBaseSquad(world);
  for (const boat of activeEnemyBoats(world)) damageEnemyBoat(world, boat.id, boat.hull, 0);
  for (const actor of activeHostileActors(world)) damageHostileActor(world, actor.id, actor.health, 0, {weapon: "automatic"});
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 190);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 4);
  updateThreatDirector(world);
  assert.equal(world.freeActivities.credits, 190);
  assert.equal(world.freeActivities.crates.filter(crate => crate.source === "encounter").length, 4);
});

test("abandoning or cancelling a battle removes active boats, actors and projectiles", () => {
  const world = twoPlayerWorld();
  startThreatEncounter(world, 4, "cancel-four");
  assert.ok(activeEnemyBoats(world).length);
  assert.ok(activeHostileActors(world).length);
  cancelThreatEncounter(world, "test");
  assert.equal(world.freeThreatDirector.active, false);
  assert.equal(activeEnemyBoats(world).length, 0);
  assert.equal(activeHostileActors(world).length, 0);
  assert.equal(world.freePursuerSquad.escorts.length, 0);
  assert.equal(world.freeActivities.marauder.active, false);
});
