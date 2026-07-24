import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js";
import {activePursuers, updatePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {activeEnemyBoats, updateEnemyBoats} from "../public/src/free-roam-enemy-boats.js";
import {activeHostileActors, updateHostileActors} from "../public/src/free-roam-hostile-actors.js";
import {updateHostileGunners} from "../public/src/free-roam-hostile-gunners.js";
import {startHeavyPursuer, updateHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";
import {finishThreatIntelligence, prepareThreatIntelligence} from "../public/src/free-roam-threat-intelligence.js";

function soloWorld() {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  world.players[0].combat.alive = true;
  world.players[1].combat.alive = true;
  world.events = [];
  return world;
}

function fighter(id, targetPlayer = 0, weapon = "automatic") {
  return {
    id,
    boatId: null,
    targetPlayer,
    x: 210,
    y: 69,
    heading: 0,
    state: "foot",
    weapon,
    health: weapon === "knife" ? 58 : 52,
    maxHealth: weapon === "knife" ? 58 : 52,
    active: true,
    destroyed: false,
    elite: false,
    fireCooldown: 0,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0,
    windupRemaining: 0,
    targetLockUntil: 9999,
    seatOffset: 0,
    strandedAt: 0,
    stepCooldown: 0,
    smartAmmo: 50,
  };
}

function threatOpening(level) {
  const world = soloWorld();
  startThreatEncounter(world, level, `audit-${level}`);
  return {
    world,
    pursuers: activePursuers(world).length,
    boats: activeEnemyBoats(world).length,
    actors: activeHostileActors(world).length,
  };
}

test("solo threat five opens with fewer combatants than threat four", () => {
  const four = threatOpening(4);
  const five = threatOpening(5);
  assert.deepEqual({pursuers: four.pursuers, boats: four.boats, actors: four.actors}, {pursuers: 3, boats: 3, actors: 6});
  assert.deepEqual({pursuers: five.pursuers, boats: five.boats, actors: five.actors}, {pursuers: 3, boats: 0, actors: 4});
  assert.ok(five.pursuers + five.boats + five.actors < four.pursuers + four.boats + four.actors);
});

test("solo threat four leaves two of three base pursuers as non-attacking reserves", () => {
  const {world} = threatOpening(4);
  assert.equal(activePursuers(world).length, 3);
  updatePursuerSquad(world, 0.05, {});
  assert.equal(Object.keys(world.freePursuerSquad.assignments).length, 1);
  const assignedIds = new Set(Object.keys(world.freePursuerSquad.assignments));
  assert.equal(activePursuers(world).filter(boat => assignedIds.has(boat.id)).length, 1);
});

function roofWorld() {
  const world = soloWorld();
  const boat = world.boats[world.players[0].activeBoat];
  world.players[0].mode = "roof";
  world.players[0].x = boat.x;
  world.players[0].y = boat.y;
  return {world, boat};
}

function directProjectile(boat, extra = {}) {
  return {
    id: "audit-bullet",
    x: boat.x,
    y: boat.y + 8,
    sourceX: boat.x,
    sourceY: boat.y + 20,
    vx: 0,
    vy: -100,
    ttl: 1,
    targetPlayer: 0,
    damage: 4,
    nearMissAnnounced: [false, false],
    ...extra,
  };
}

test("a player on the roof is shielded by the boat from every enemy bullet system", () => {
  const systems = [];

  {
    const {world, boat} = roofWorld();
    world.freePursuerSquad.activated = true;
    world.freePursuerSquad.escorts = [];
    world.freeActivities.marauder.active = false;
    world.freePursuerSquad.projectiles = [directProjectile(boat, {sourcePursuerId: "pursuer-audit"})];
    let playerDamage = 0;
    const beforeHull = boat.hull;
    updatePursuerSquad(world, 0.05, {damagePlayer(_w, _i, amount) { playerDamage += amount; }});
    systems.push(["pursuer", beforeHull - boat.hull, playerDamage]);
  }

  {
    const {world, boat} = roofWorld();
    world.freeEnemyBoats = {active: true, level: 4, boats: [], projectiles: [directProjectile(boat, {boatId: "enemy-audit"})], nextProjectileId: 2};
    let playerDamage = 0;
    const beforeHull = boat.hull;
    updateEnemyBoats(world, 0.05, {damagePlayer(_w, _i, amount) { playerDamage += amount; }});
    systems.push(["enemy-boat", beforeHull - boat.hull, playerDamage]);
  }

  {
    const {world, boat} = roofWorld();
    world.freeHostileActors = {active: true, level: 4, actors: [], projectiles: [directProjectile(boat, {actorId: "actor-audit", weapon: "automatic"})], nextProjectileId: 2};
    let playerDamage = 0;
    const beforeHull = boat.hull;
    updateHostileActors(world, 0.05, {damagePlayer(_w, _i, amount) { playerDamage += amount; }});
    systems.push(["infantry", beforeHull - boat.hull, playerDamage]);
  }

  {
    const {world, boat} = roofWorld();
    startHeavyPursuer(world, 1, {x: 30, y: 230}, 0);
    world.freeHeavyPursuer.projectiles = [directProjectile(boat)];
    let playerDamage = 0;
    const beforeHull = boat.hull;
    updateHeavyPursuer(world, 0.05, {damagePlayer(_w, _i, amount) { playerDamage += amount; }});
    systems.push(["heavy", beforeHull - boat.hull, playerDamage]);
  }

  for (const [name, hullLoss, playerDamage] of systems) {
    assert.ok(hullLoss > 0, `${name} bullet should damage the boat`);
    assert.equal(playerDamage, 0, `${name} bullet must not damage roof player in current code`);
  }
});

test("stranded ranged infantry cannot attack a player seated in a boat", () => {
  const world = soloWorld();
  const boat = world.boats[world.players[0].activeBoat];
  Object.assign(world.players[0], {mode: "boat", x: boat.x, y: boat.y});
  const actor = fighter("stranded-ranged");
  actor.x = boat.x + 20;
  actor.y = 69;
  world.freeActivities.marauder.active = false;
  world.freePursuerSquad.activated = false;
  world.freeEnemyBoats = {active: false, level: 0, boats: [], projectiles: [], nextProjectileId: 1};
  world.freeHeavyPursuer = {active: false, boat: null, projectiles: [], nextProjectileId: 1};
  world.freeHostileActors = {active: true, level: 4, actors: [actor], projectiles: [], nextProjectileId: 1};
  let damage = 0;
  const before = {x: actor.x, y: actor.y};
  for (let index = 0; index < 240; index += 1) {
    updateHostileActors(world, 0.05, {damagePlayer(_w, _i, amount) { damage += amount; }});
    world.time += 0.05;
  }
  assert.equal(damage, 0);
  assert.equal(world.freeHostileActors.projectiles.length, 0);
  assert.deepEqual({x: actor.x, y: actor.y}, before);
  assert.equal(actor.state, "foot");
});

test("infantry keep dogpiling the survivor after the teammate respawns", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  world.freeHostileActors = {
    active: true,
    level: 4,
    actors: [fighter("dogpile-a", 0), fighter("dogpile-b", 0), fighter("dogpile-c", 0)],
    projectiles: [],
    nextProjectileId: 1,
  };
  prepareThreatIntelligence(world);
  world.players[0].combat.alive = false;
  world.players[0].mode = "dead";
  prepareThreatIntelligence(world);
  assert.deepEqual(new Set(world.freeHostileActors.actors.map(actor => actor.targetPlayer)), new Set([1]));

  world.players[0].combat.alive = true;
  world.players[0].mode = "foot";
  world.time += 2.3;
  for (let index = 0; index < 40; index += 1) {
    prepareThreatIntelligence(world);
    world.time += 0.25;
  }
  assert.deepEqual(new Set(world.freeHostileActors.actors.map(actor => actor.targetPlayer)), new Set([1]));
});

test("legacy shore gunners keep identical fixed four-shot bursts", () => {
  const world = soloWorld();
  const player = world.players[0];
  Object.assign(player, {mode: "foot", activeBoat: null, x: 210, y: 40});
  const pursuer = world.freeActivities.marauder;
  Object.assign(pursuer, {id: "pursuer-1", active: true, destroyed: false, x: 210, y: 80, heading: 180, speed: 0});
  world.freePursuerSquad.activated = true;
  world.freePursuerSquad.escorts = [];
  world.freePursuerSquad.assignments = {"pursuer-1": 0};
  world.freeHostileGunners = {gunners: [], projectiles: [], eliminatedPursuers: [], nextProjectileId: 1};

  const shotTimes = [];
  let seen = 0;
  for (let index = 0; index < 220; index += 1) {
    const frame = prepareThreatIntelligence(world);
    updateHostileGunners(world, 0.05, {});
    finishThreatIntelligence(world, frame, 0.05);
    const shots = world.events.slice(seen).filter(event => event.type === "enemy-gun-shot");
    for (const _shot of shots) shotTimes.push(Number(world.time.toFixed(2)));
    seen = world.events.length;
    world.time += 0.05;
  }
  assert.ok(shotTimes.length >= 8);
  const groups = [];
  let current = [];
  for (const time of shotTimes) {
    if (current.length && time - current.at(-1) > 0.5) { groups.push(current); current = []; }
    current.push(time);
  }
  if (current.length) groups.push(current);
  assert.ok(groups.length >= 2);
  assert.deepEqual(groups.slice(0, 2).map(group => group.length), [4, 4]);
});

test("the heavy pursuer receives a second movement pass every game tick", () => {
  const baseWorld = soloWorld();
  startHeavyPursuer(baseWorld, 1, {x: 40, y: 230}, 0);
  Object.assign(baseWorld.freeHeavyPursuer.boat, {x: 340, y: 280, heading: -40, speed: 8});
  const intelligentWorld = structuredClone(baseWorld);

  const baseBefore = {x: baseWorld.freeHeavyPursuer.boat.x, y: baseWorld.freeHeavyPursuer.boat.y};
  updateHeavyPursuer(baseWorld, 0.1, {});
  const baseMove = Math.hypot(baseWorld.freeHeavyPursuer.boat.x - baseBefore.x, baseWorld.freeHeavyPursuer.boat.y - baseBefore.y);

  const intelligentBefore = {x: intelligentWorld.freeHeavyPursuer.boat.x, y: intelligentWorld.freeHeavyPursuer.boat.y};
  const frame = prepareThreatIntelligence(intelligentWorld);
  updateHeavyPursuer(intelligentWorld, 0.1, {});
  finishThreatIntelligence(intelligentWorld, frame, 0.1);
  const intelligentMove = Math.hypot(intelligentWorld.freeHeavyPursuer.boat.x - intelligentBefore.x, intelligentWorld.freeHeavyPursuer.boat.y - intelligentBefore.y);

  assert.ok(intelligentMove > baseMove * 1.7, `expected double movement, base=${baseMove}, integrated=${intelligentMove}`);
});
