import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerPresence, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {
  ELITE_ARMOR_LAYER_HP,
  ELITE_HULL_HP,
  ELITE_TURRET_HP,
  damageEliteBoatBoss,
  eliteBossCombatTargets,
  ensureEliteBoatBoss,
  resetEliteBoatBoss,
  startEliteBoatBoss,
  updateEliteBoatBoss,
} from "../public/src/free-roam-elite-boat.js";
import {activeHostileActors, damageHostileActor} from "../public/src/free-roam-hostile-actors.js";
import {applyCombatDamage} from "../public/src/free-roam-combat-v2.js";
import {activeHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";
import {notifyThreatBoatDestroyed, startThreatEncounter, updateThreatDirector} from "../public/src/free-roam-threat-director.js";
import {launchPendingEliteBossBombs, stepMegaBombs} from "../src/free-roam-mega-bomb.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";

function run(world, seconds, dt = 0.04) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepFreeWorld(world, dt);
}

function bossWorld(coop = false) {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, coop);
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    player.mode = "boat";
    player.activeBoat = index;
    world.boats[index].id ||= index;
    world.boats[index].driver = index;
    world.boats[index].owner = index;
    world.boats[index].x = 185 + index * 40;
    world.boats[index].y = 185;
    player.x = world.boats[index].x;
    player.y = world.boats[index].y;
  }
  const state = startEliteBoatBoss(world, 9, {x: 210, y: 180}, 0);
  state.phase = "boat-combat";
  state.boat.x = 300;
  state.boat.y = 185;
  state.boat.heading = -90;
  state.boat.speed = 0;
  return world;
}

function breakArmor(world) {
  for (const id of ["outer", "middle", "inner"]) {
    assert.equal(damageEliteBoatBoss(world, `armor-${id}`, ELITE_ARMOR_LAYER_HP, 0, {weapon: "automatic"}), true);
  }
}

test("threat five starts the separate elite boss only after the heavy boat is destroyed", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 0, true);
  startThreatEncounter(world, 5, "boss-contract");
  assert.equal(ensureEliteBoatBoss(world).active, false);
  world.time = world.freeThreatDirector.heavyStartsAt;
  updateThreatDirector(world);
  const heavy = activeHeavyPursuer(world);
  assert.ok(heavy);
  assert.equal(ensureEliteBoatBoss(world).active, false);

  heavy.active = false;
  heavy.destroyed = true;
  notifyThreatBoatDestroyed(world, heavy, 0);
  const boss = ensureEliteBoatBoss(world);
  assert.equal(boss.active, true);
  assert.equal(boss.threatEncounterId, world.freeThreatDirector.encounterId);
  assert.equal(boss.boat.armorLayers.length, 3);
  assert.equal(boss.boat.armorLayers.every(layer => layer.hp === 1000), true);
  assert.equal(boss.boat.hull, 5000);
});

test("three armor layers are sequential and the hull cannot be skipped", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  assert.deepEqual(eliteBossCombatTargets(world, 0).map(target => target.id), ["elite-armor-outer", "elite-turret-port", "elite-turret-starboard"]);
  assert.equal(damageEliteBoatBoss(world, "hull", 9000, 0, {weapon: "automatic"}), false);
  assert.equal(state.boat.hull, ELITE_HULL_HP);

  damageEliteBoatBoss(world, "armor-outer", 1400, 0, {weapon: "automatic"});
  assert.equal(state.boat.armorLayers[0].hp, 0);
  assert.equal(state.boat.armorLayers[1].hp, ELITE_ARMOR_LAYER_HP, "overkill must not skip a layer");
  assert.equal(state.stage, "armor-middle");
  damageEliteBoatBoss(world, "armor-middle", 1000, 0, {weapon: "automatic"});
  damageEliteBoatBoss(world, "armor-inner", 1000, 0, {weapon: "automatic"});
  assert.equal(state.stage, "hull-exposed");
  assert.equal(state.boat.hullState, "exposed");
  assert.equal(eliteBossCombatTargets(world, 0)[0].id, "elite-hull");
});

test("the two turrets have independent health, muzzle positions and firing cycles", () => {
  const world = bossWorld(true);
  const state = ensureEliteBoatBoss(world);
  const [port, starboard] = state.boat.turrets;
  assert.notEqual(port.id, starboard.id);
  assert.equal(port.hp, ELITE_TURRET_HP);
  assert.equal(starboard.hp, ELITE_TURRET_HP);
  damageEliteBoatBoss(world, "turret-port", ELITE_TURRET_HP, 0, {weapon: "automatic"});
  assert.equal(port.destroyed, true);
  assert.equal(starboard.destroyed, false);

  starboard.fireCooldown = 0;
  updateEliteBoatBoss(world, 0.1, {});
  for (let index = 0; index < 8; index += 1) updateEliteBoatBoss(world, 0.1, {});
  const shotEvents = world.events.filter(event => event.type === "elite-turret-shot" && event.turretId === starboard.id);
  assert.ok(shotEvents.length > 0, "the surviving physical turret must continue firing even if its bullets have already hit");
  assert.equal(world.events.some(event => event.type === "elite-turret-shot" && event.turretId === port.id), false);
  const shotEvent = shotEvents[0];
  assert.equal(shotEvent.aimSection, "front");
  assert.notEqual(Math.round(shotEvent.x * 10), Math.round(state.boat.x * 10));
});

test("one physical turret bullet can damage an occupied boat and its protected occupant", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  const boat = world.boats[0];
  boat.hull = 100;
  boat.leak = 0;
  const healthBefore = world.players[0].combat.health;
  let recordedDamage = 0;
  state.projectiles = [{
    id: "penetration-test", turretId: "elite-turret-starboard", targetPlayer: 0,
    x: boat.x - 2, y: boat.y, sourceX: state.boat.x, sourceY: state.boat.y,
    vx: 80, vy: 0, ttl: 1,
  }];
  updateEliteBoatBoss(world, 0.05, {
    damagePlayer(targetWorld, index, amount, details) {
      recordedDamage += amount;
      return applyCombatDamage(targetWorld, index, amount, -1, details, {});
    },
  });
  assert.ok(boat.hull < 100);
  assert.ok(recordedDamage > 0);
  assert.ok(recordedDamage < 7.2, "an intact hull must absorb most of the direct bullet");
  assert.ok(world.players[0].combat.health < healthBefore);
  assert.equal(state.projectiles.length, 0);
  const penetration = world.events.find(event => event.type === "elite-bullet-penetration");
  assert.ok(penetration);
  assert.equal(penetration.text, "", "dense fire must not enqueue one spoken sentence per bullet");
  assert.equal(world.events.some(event => event.type === "combat-health"), false, "dense fire must not queue stale health speech after every bullet");
  assert.ok(world.events.some(event => event.type === "elite-bullet-player-hit"), "the common combat impact event must still be emitted");
});

test("the ship stays in map bounds and its projectile population is bounded", () => {
  const world = bossWorld(true);
  const state = ensureEliteBoatBoss(world);
  state.boat.x = 404.9;
  state.boat.y = 304.9;
  for (const turret of state.boat.turrets) turret.fireCooldown = 0;
  for (let index = 0; index < 1500; index += 1) updateEliteBoatBoss(world, 0.04, {});
  assert.ok(state.boat.x >= 15 && state.boat.x <= 405);
  assert.ok(state.boat.y >= 84 && state.boat.y <= 305);
  assert.ok(state.projectiles.length <= 96);
  assert.ok(Number.isFinite(state.boat.heading));
});

test("the boat fires a finite three-bomb salvo through the common physical bomb system", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  state.boat.x = 300;
  state.boat.y = 185;
  world.boats[0].x = 200;
  world.boats[0].y = 185;
  state.bombCooldown = 0;
  for (let index = 0; index < 40; index += 1) {
    updateEliteBoatBoss(world, 0.1, {});
    launchPendingEliteBossBombs(world);
    stepMegaBombs(world, 0.1);
  }
  const launches = world.events.filter(event => event.type === "mega-bomb-launch" && event.hostile && event.sourceType === "elite-boat");
  assert.equal(launches.length, 3);
  assert.equal(state.salvoRemaining, 0);
  assert.ok(state.bombCooldown > 0);
  assert.ok(world.events.some(event => event.type === "mega-bomb-explosion" && event.sourcePlayer === -1));
});

test("destroying the hull deploys exactly one physical commander and victory waits for the commander", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  breakArmor(world);
  damageEliteBoatBoss(world, "hull", ELITE_HULL_HP, 0, {weapon: "automatic"});
  assert.equal(state.phase, "boat-destroying");
  assert.equal(state.boat.alive, false);
  for (let index = 0; index < 50; index += 1) updateEliteBoatBoss(world, 0.04, {});
  const commanders = activeHostileActors(world).filter(actor => actor.commander);
  assert.equal(commanders.length, 1);
  const commander = commanders[0];
  assert.equal(state.phase, "commander-combat");
  assert.equal(commander.health, 600);
  assert.equal(commander.armor, 200);
  assert.equal(state.rewardReady, false);

  damageHostileActor(world, commander.id, 800, 0, {weapon: "mega-bomb"});
  updateEliteBoatBoss(world, 0.04, {});
  assert.equal(state.phase, "completed");
  assert.equal(state.rewardReady, true);
  updateEliteBoatBoss(world, 0.04, {});
  assert.equal(activeHostileActors(world).filter(actor => actor.commander).length, 0);
  assert.equal(world.events.filter(event => event.type === "elite-boss-completed").length, 1);
});

test("reset clears commander, projectiles, pending bombs and locked elite targets", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  state.projectiles.push({id: "leftover"});
  state.bombRequests.push({id: "leftover-bomb"});
  world.freeMegaBombs ||= {projectiles: [], nextId: 1};
  world.freeMegaBombs.projectiles.push(
    {id: "elite-launched-bomb", eliteBossEncounterId: state.encounterId},
    {id: "unrelated-player-bomb", eliteBossEncounterId: state.encounterId + 99},
  );
  world.players[0].combat.lockedTargetId = "elite-armor-outer";
  breakArmor(world);
  damageEliteBoatBoss(world, "hull", ELITE_HULL_HP, 0, {weapon: "automatic"});
  for (let index = 0; index < 50; index += 1) updateEliteBoatBoss(world, 0.04, {});
  assert.equal(activeHostileActors(world).some(actor => actor.commander), true);
  resetEliteBoatBoss(world, "world-change");
  assert.equal(world.freeEliteBoatBoss.active, false);
  assert.equal(world.freeEliteBoatBoss.projectiles.length, 0);
  assert.equal(world.freeEliteBoatBoss.bombRequests.length, 0);
  assert.deepEqual(world.freeMegaBombs.projectiles.map(projectile => projectile.id), ["unrelated-player-bomb"]);
  assert.equal(activeHostileActors(world).some(actor => actor.commander), false);
  assert.equal(world.players[0].combat.lockedTargetId, null);
});

test("starting a new threat encounter cleans the old boss lifecycle before replacement", () => {
  const world = bossWorld();
  const old = ensureEliteBoatBoss(world);
  old.projectiles.push({id: "old-bullet"});
  old.bombRequests.push({id: "old-request"});
  world.freeMegaBombs ||= {projectiles: [], nextId: 1};
  world.freeMegaBombs.projectiles.push({id: "old-bomb", eliteBossEncounterId: old.encounterId});
  const replacement = startEliteBoatBoss(world, old.threatEncounterId + 1, {x: 160, y: 170}, 0);
  assert.notEqual(replacement.encounterId, old.encounterId);
  assert.equal(replacement.projectiles.length, 0);
  assert.equal(replacement.bombRequests.length, 0);
  assert.equal(world.freeMegaBombs.projectiles.some(projectile => projectile.id === "old-bomb"), false);
});

test("replication gives both clients the same boss phase, layers, turrets and physical bullets", () => {
  const world = bossWorld(true);
  const state = ensureEliteBoatBoss(world);
  state.projectiles.push({id: "replicated-bullet", turretId: "elite-turret-port", x: 250, y: 180, vx: 100, vy: 0, ttl: 2});
  const left = replicatedFreeWorld(world, 0);
  const right = replicatedFreeWorld(world, 1);
  assert.deepEqual(left.freeEliteBoatBoss, right.freeEliteBoatBoss);
  assert.equal(left.freeEliteBoatBoss.stage, "armor-outer");
  assert.equal(left.freeEliteBoatBoss.boat.armorLayers.length, 3);
  assert.equal(left.freeEliteBoatBoss.boat.turrets.length, 2);
  assert.equal(left.freeEliteBoatBoss.projectiles[0].id, "replicated-bullet");
});
