import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCombatAiModelV164,
  PROJECTILE_RANGES,
} from "../public/src/free-roam-combat-ai-model-v164.js";

function worldFixture() {
  return {
    time: 100,
    events: [],
    players: [
      {x: 120, y: 60, mode: "foot", activeBoat: null, combat: {alive: true}},
      {x: 300, y: 60, mode: "foot", activeBoat: null, combat: {alive: false}},
    ],
    boats: [],
    freeActivities: {presence: [true, true], marauder: null},
    freePursuerSquad: {escorts: [], projectiles: [], assignments: {}},
    freeHostileActors: {actors: [], projectiles: []},
    freeHostileGunners: {gunners: [], projectiles: []},
    freeEnemyBoats: {boats: [], projectiles: []},
    freeHeavyPursuer: {active: true, encounterId: 8, projectiles: [], boat: {
      id: "heavy-pursuer",
      role: "heavy",
      x: 330,
      y: 250,
      heading: -30,
      turretHeading: -30,
      speed: 0,
      hull: 700,
      maxHull: 700,
      engineHealth: 180,
      maxEngineHealth: 180,
      turretHealth: 240,
      maxTurretHealth: 240,
      engineDisabled: false,
      turretDisabled: false,
      active: true,
      destroyed: false,
      targetPlayer: 0,
      fireCooldown: 1,
      aimRemaining: 0,
      burstRemaining: 0,
      burstCooldown: 0,
    }},
    freeThreatDirector: {active: true, level: 5, encounterId: 8},
  };
}

function pre(world) {
  applyCombatAiModelV164(world, 0);
}

function post(world, dt = 0.05) {
  world.time += dt;
  applyCombatAiModelV164(world, dt);
}

test("new heavy pursuer enters physically before combat", () => {
  const world = worldFixture();
  world.events.push({type: "heavy-pursuer-arrived", text: "old", targets: [0, 1]});
  pre(world);
  const heavy = world.freeCombatAiV164.heavy;
  assert.equal(heavy.phase, "approach");
  assert.equal(world.freeHeavyPursuer.boat.x, 412);
  assert.equal(world.events[0].type, "heavy-pursuer-approaching");
  const start = {x: world.freeHeavyPursuer.boat.x, y: world.freeHeavyPursuer.boat.y};
  post(world, 1);
  assert.notDeepEqual({x: world.freeHeavyPursuer.boat.x, y: world.freeHeavyPursuer.boat.y}, start);
  assert.equal(world.freeHeavyPursuer.boat.turretDisabled, true);
});

test("destroying armour exposes a live core instead of killing heavy boat", () => {
  const world = worldFixture();
  pre(world);
  const boat = world.freeHeavyPursuer.boat;
  boat.hull = 0;
  boat.active = false;
  boat.destroyed = true;
  world.freeHeavyPursuer.active = false;
  world.events.push({type: "heavy-pursuer-destroyed", text: "wrong", targets: [0, 1]});
  post(world);
  assert.equal(boat.active, true);
  assert.equal(boat.destroyed, false);
  assert.equal(world.freeCombatAiV164.heavy.armourBreached, true);
  assert.equal(boat.maxHull, 260);
  assert.equal(boat.hull, 260);
  assert.equal(world.events.some(event => event.type === "heavy-pursuer-destroyed"), false);
  assert.equal(world.events.some(event => event.type === "heavy-armour-breached"), true);
});

test("systems are armoured before breach and vulnerable after breach", () => {
  const world = worldFixture();
  pre(world);
  const boat = world.freeHeavyPursuer.boat;
  boat.engineHealth -= 30;
  world.events.push({type: "heavy-component-hit", component: "engine", targets: [0]});
  post(world);
  assert.equal(Math.round(boat.engineHealth), 171, "only 30 percent of pre-breach system damage should remain");

  world.freeCombatAiV164.heavy.armourBreached = true;
  pre(world);
  const before = boat.engineHealth;
  boat.engineHealth -= 20;
  world.events.push({type: "heavy-component-hit", component: "engine", targets: [0]});
  post(world);
  assert.equal(boat.engineHealth, before - 50, "post-breach system damage should be amplified");
});

test("V164 records a destroyed turret but never starts its deleted repair lifecycle", () => {
  const world = worldFixture();
  pre(world);
  const boat = world.freeHeavyPursuer.boat;
  boat.turretHealth = 2;
  pre(world);
  boat.turretHealth = 0;
  boat.turretDisabled = true;
  world.events.push({type: "heavy-component-hit", component: "turret", weapon: "automatic", targets: [0]});
  world.events.push({type: "heavy-turret-destroyed", targets: [0, 1]});
  post(world);
  const heavy = world.freeCombatAiV164.heavy;
  assert.equal(heavy.phase, "combat");
  assert.equal(heavy.actualTurretDisabled, true);
  assert.equal(heavy.repairSystem, null);
  assert.equal(heavy.repairPlates, 3);
  assert.equal(world.events.some(event => ["heavy-repair-retreat", "heavy-repair-start", "heavy-repair-complete"].includes(event.type)), false);
});

test("enemy assigned to a dead player physically searches the last position", () => {
  const world = worldFixture();
  const actor = {
    id: "hostile-searcher",
    targetPlayer: 1,
    x: 220,
    y: 50,
    heading: 0,
    state: "foot",
    weapon: "automatic",
    active: true,
    destroyed: false,
    burstRemaining: 4,
    aimRemaining: 1,
    windupRemaining: 0,
    fireCooldown: 0,
  };
  world.freeHostileActors.actors.push(actor);
  pre(world);
  post(world, 1);
  assert.ok(actor.x > 220, "actor should move toward dead player's x=300");
  assert.equal(actor.targetPlayer, 1);
  assert.equal(actor.burstRemaining, 0);
  assert.equal(actor.aimRemaining, 0);
  assert.equal(world.events.some(event => event.type === "hostile-footstep" && event.searching), true);
});

test("all enemy projectile families are removed at their physical maximum range", () => {
  const world = worldFixture();
  world.freePursuerSquad.projectiles.push({id: "p", sourceX: 0, sourceY: 100, x: PROJECTILE_RANGES.pursuer + 1, y: 100, ttl: 5});
  world.freeHostileGunners.projectiles.push({id: "g", sourceX: 0, sourceY: 100, x: PROJECTILE_RANGES.gunner + 1, y: 100, ttl: 5});
  world.freeHostileActors.projectiles.push({id: "a", weapon: "automatic", sourceX: 0, sourceY: 100, x: PROJECTILE_RANGES.hostileAutomatic + 1, y: 100, ttl: 5});
  world.freeEnemyBoats.projectiles.push({id: "b", sourceX: 0, sourceY: 100, x: PROJECTILE_RANGES.enemyBoat + 1, y: 100, ttl: 5});
  world.freeHeavyPursuer.projectiles.push({id: "h", sourceX: 0, sourceY: 100, x: PROJECTILE_RANGES.heavy + 1, y: 100, ttl: 5});
  pre(world);
  assert.equal(world.freePursuerSquad.projectiles.length, 0);
  assert.equal(world.freeHostileGunners.projectiles.length, 0);
  assert.equal(world.freeHostileActors.projectiles.length, 0);
  assert.equal(world.freeEnemyBoats.projectiles.length, 0);
  assert.equal(world.freeHeavyPursuer.projectiles.length, 0);
});