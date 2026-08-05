import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {createFreeWorld, setPlayerPresence} from "../public/src/free-roam-core-v6.js";
import {
  ELITE_BOMB_BAY_HP,
  ELITE_BOMB_RELOAD_SECONDS,
  ELITE_TURRET_HP,
  damageEliteBoatBoss,
  eliteBossCombatTargets,
  ensureEliteBoatBoss,
  startEliteBoatBoss,
  updateEliteBoatBoss,
} from "../public/src/free-roam-elite-boat.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";
import {ensureMegaBombState, launchPendingEliteBossBombs} from "../src/free-roam-mega-bomb.js";

function bossWorld(coop = true) {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, coop);
  world.freeThreatDirector ||= {graceUntil: [0, 0]};
  world.freeThreatDirector.graceUntil = [0, 0];
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    player.mode = "boat";
    player.activeBoat = index;
    player.combat.alive = true;
    world.boats[index].id ||= index;
    world.boats[index].driver = index;
    world.boats[index].owner = index;
    world.boats[index].x = 165 + index * 70;
    world.boats[index].y = 185;
    world.boats[index].heading = index ? 270 : 90;
    world.boats[index].speed = 7 + index * 3;
  }
  const state = startEliteBoatBoss(world, 41, {x: 210, y: 180}, 0);
  state.phase = "boat-combat";
  state.boat.x = 300;
  state.boat.y = 185;
  state.boat.heading = 270;
  state.boat.speed = 12;
  return world;
}

function stepBoss(world, seconds, dt = 0.04) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) {
    world.time += dt;
    updateEliteBoatBoss(world, dt, {});
  }
}

test("journal tactics are part of the authoritative boss state, not a parallel layer", () => {
  const world = bossWorld();
  const state = ensureEliteBoatBoss(world);
  assert.ok(state.tactical);
  assert.equal(state.tactical.playerMemory.length, world.players.length);
  assert.equal(world.freeEliteBossJournalTactics, undefined);
  assert.equal(fs.existsSync(new URL("../src/free-roam-elite-boss-journal-v13.js", import.meta.url)), false);
});

test("memory persists for the encounter and two turrets split primary and secondary targets", () => {
  const world = bossWorld(true);
  world.players[1].combat.attackCooldown = 1;
  stepBoss(world, 0.4);
  const state = ensureEliteBoatBoss(world);
  const memory = state.tactical.playerMemory[1];
  assert.ok(memory.lastSeenAt >= 0);
  assert.ok(memory.recentFire > 0);
  assert.notEqual(state.tactical.primaryTarget, null);
  assert.notEqual(state.tactical.secondaryTarget, null);
  const targets = state.boat.turrets.filter(turret => !turret.destroyed).map(turret => turret.targetPlayer);
  assert.equal(new Set(targets).size, 2);

  world.players[1].combat.alive = false;
  const rememberedShots = memory.shotsObserved;
  stepBoss(world, 0.2);
  assert.equal(state.tactical.playerMemory[1].shotsObserved, rememberedShots);
  assert.equal(state.encounterId, 2);
});

test("closed bomb bay is strongly protected, open bay is a real target and its destruction disables bombs", () => {
  const world = bossWorld(false);
  const state = ensureEliteBoatBoss(world);
  const before = state.bombBay.hp;
  assert.equal(damageEliteBoatBoss(world, "bomb-bay", 100, 0, {weapon: "automatic"}), true);
  assert.equal(state.bombBay.hp, before - 8);

  state.bombBayState = "open";
  state.bombBay.state = "open";
  state.bombBay.exposed = true;
  state.boat.bombBayState = "open";
  const openTarget = eliteBossCombatTargets(world, 0).find(target => target.component === "bomb-bay");
  assert.ok(openTarget);
  assert.equal(openTarget.id, state.bombBay.id);

  damageEliteBoatBoss(world, "bomb-bay", ELITE_BOMB_BAY_HP * 2, 0, {weapon: "automatic"});
  assert.equal(state.bombBay.destroyed, true);
  assert.equal(state.bombBayState, "destroyed");
  assert.equal(state.bombRequests.length, 0);
  stepBoss(world, 12);
  assert.equal(state.bombRequests.length, 0);
  assert.equal(eliteBossCombatTargets(world, 0).some(target => target.component === "bomb-bay"), false);
});

test("turret bullets are physical server objects and retain boat velocity", () => {
  const world = bossWorld(false);
  const state = ensureEliteBoatBoss(world);
  const turret = state.boat.turrets[0];
  turret.fireCooldown = 0;
  stepBoss(world, 0.5);
  assert.ok(state.projectiles.length > 0);
  const projectile = state.projectiles[0];
  assert.ok(projectile.id.startsWith("elite-bullet-"));
  assert.ok(Number.isFinite(projectile.vx));
  assert.ok(Number.isFinite(projectile.vy));
  assert.ok(projectile.speed > 0);
  assert.ok(projectile.mass > 0);
  assert.ok(projectile.energy > 0);
  assert.ok(projectile.inheritedBoatVelocity > 0);
  assert.ok(Number.isFinite(projectile.spawnedAt));

  const replica = replicatedFreeWorld(world).freeEliteBoatBoss.projectiles[0];
  assert.equal(replica.id, projectile.id);
  assert.ok(Number.isFinite(replica.vx));
  assert.ok(Number.isFinite(replica.vy));
  assert.ok(replica.energy > 0);
  assert.ok(replica.mass > 0);
});

test("a bomb salvo stores mixed tactical roles and uses roughly ten seconds of reload", () => {
  const world = bossWorld(true);
  const state = ensureEliteBoatBoss(world);
  state.boat.x = 300;
  state.boat.y = 185;
  state.bombCooldown = 0;
  state.bombBayState = "opening";
  state.bombBay.state = "opening";
  state.bombBay.exposed = true;
  state.bombBayTimer = 0;

  stepBoss(world, 1.8, 0.06);
  assert.equal(state.bombRequests.length, 3);
  const roles = state.bombRequests.map(request => request.tacticalRole);
  assert.ok(new Set(roles).size >= 2);
  assert.ok(roles.every(Boolean));
  assert.ok(state.bombRequests.every(request => Number.isFinite(request.sourceVx) && Number.isFinite(request.sourceVy)));
  assert.ok(state.bombCooldown > ELITE_BOMB_RELOAD_SECONDS - 1);
});

test("losing one turret changes combat posture and complete disarmament switches to survival or physical ram", () => {
  const world = bossWorld(false);
  const state = ensureEliteBoatBoss(world);
  damageEliteBoatBoss(world, "turret-port", ELITE_TURRET_HP, 0, {weapon: "automatic"});
  stepBoss(world, 0.4);
  assert.equal(state.boat.turrets[0].destroyed, true);
  assert.ok(state.boat.turrets[1].targetPlayer === 0);

  damageEliteBoatBoss(world, "turret-starboard", ELITE_TURRET_HP, 0, {weapon: "automatic"});
  state.bombBay.destroyed = true;
  state.bombBayState = "destroyed";
  state.bombBay.state = "destroyed";
  stepBoss(world, 0.4);
  assert.ok(["disarmed-survival", "physical-ram"].includes(state.boat.movementState));
});

test("hostile bomb launcher keeps tactical role and physical source velocity", () => {
  const world = bossWorld(false);
  const state = ensureEliteBoatBoss(world);
  ensureMegaBombState(world);
  state.bombRequests = [{
    id: "role-test",
    sourceType: "elite-boat",
    sourceId: state.boat.id,
    x: state.boat.x,
    y: state.boat.y,
    heading: 0,
    targetX: 200,
    targetY: 185,
    targetPlayer: 0,
    tacticalRole: "route-denial",
    sourceVx: 9,
    sourceVy: -3,
  }];
  assert.equal(launchPendingEliteBossBombs(world), 1);
  const projectile = world.freeMegaBombs.projectiles.at(-1);
  assert.equal(projectile.tacticalRole, "route-denial");
  assert.equal(projectile.sourceVelocityVx, 9);
  assert.equal(projectile.sourceVelocityVy, -3);
});
