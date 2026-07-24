import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {classifyActionGesture} from "../public/src/free-roam-action-gestures.js";
import {combatMenuActive, contractCombatActive} from "../public/src/free-roam-combat-context.js";
import {createTargetMenu} from "../public/src/free-roam-target-menu.js";
import {startEnemyBoats, updateEnemyBoats} from "../public/src/free-roam-enemy-boats.js";
import {startHeavyPursuer, updateHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";
import {startHostileActors} from "../public/src/free-roam-hostile-actors.js";
import {
  finishThreatIntelligence,
  livingThreatTargets,
  prepareThreatIntelligence,
} from "../public/src/free-roam-threat-intelligence.js";

function run(update, world, seconds, helpers = {}, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    world.time += dt;
    update(world, dt, helpers);
  }
}

test("two-finger sonar and three-finger target menu remain separate", () => {
  assert.equal(classifyActionGesture({pointers: 2, duration: 100, movement: 0, dx: 0, dy: 0, taps: 1}), "sonar");
  assert.equal(classifyActionGesture({pointers: 3, duration: 100, movement: 0, dx: 0, dy: 0, taps: 2}), "targets");
});

test("physical contract enemies keep the menu active even if the contract flag is late", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  world.freeContracts.encounterActive = false;
  startEnemyBoats(world, 4, {x: 210, y: 180});
  assert.equal(contractCombatActive(world), true);
  assert.equal(combatMenuActive(world), true);

  const spoken = [];
  const menu = createTargetMenu({
    getWorld: () => world,
    getPlayerIndex: () => 0,
    getTargetId: () => null,
    setTargetId: () => {},
    releaseMovement: () => {},
    sendInput: () => {},
    announce: text => spoken.push(text),
    render: () => {},
  });
  menu.open();
  assert.ok(menu.snapshot().targets.length > 0);
  assert.equal(menu.snapshot().targets.some(id => id.startsWith("navigation-")), false);
  assert.match(spoken.at(-1), /Боевая цель/);
});

test("death redistributes pressure and respawn has short reacquisition grace", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  startEnemyBoats(world, 4, {x: 210, y: 180});
  prepareThreatIntelligence(world);
  world.players[0].combat.alive = false;
  world.players[0].mode = "dead";
  prepareThreatIntelligence(world);
  assert.equal(world.freeEnemyBoats.boats.every(boat => boat.targetPlayer === 1), true);
  assert.deepEqual(livingThreatTargets(world).map(item => item.index), [1]);

  world.players[0].combat.alive = true;
  world.players[0].mode = "foot";
  prepareThreatIntelligence(world);
  assert.deepEqual(livingThreatTargets(world).map(item => item.index), [1]);
  world.time += 2.3;
  assert.deepEqual(livingThreatTargets(world).map(item => item.index).sort(), [0, 1]);
});

test("when both players are dead hostile fire pauses instead of attacking corpses", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  startEnemyBoats(world, 4, {x: 210, y: 180});
  world.freeEnemyBoats.projectiles.push({id: "old"});
  for (const player of world.players) {
    player.combat.alive = false;
    player.mode = "dead";
  }
  const frame = prepareThreatIntelligence(world);
  assert.equal(frame.hasLivingTargets, false);
  assert.equal(world.freeEnemyBoats.projectiles.length, 0);
  assert.equal(world.freeEnemyBoats.boats.every(boat => boat.targetPlayer == null), true);
});

test("two players locking the same enemy make it evade without increasing health", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  startEnemyBoats(world, 4, {x: 210, y: 180});
  const boat = world.freeEnemyBoats.boats[0];
  world.players[0].combat.lockedTargetId = boat.id;
  world.players[1].combat.lockedTargetId = boat.id;
  const before = {x: boat.x, y: boat.y, hull: boat.hull};
  const frame = prepareThreatIntelligence(world);
  finishThreatIntelligence(world, frame, 0.1);
  assert.ok(boat.evasiveUntil > world.time);
  assert.notDeepEqual({x: boat.x, y: boat.y}, {x: before.x, y: before.y});
  assert.equal(boat.hull, before.hull);
});

test("fast manoeuvring boats can turn some physical bullet hits into near misses", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  Object.assign(boat, {speed: 18, rudder: 1, hull: 80, leak: 2});
  const frame = prepareThreatIntelligence(world);
  const beforeEvents = world.events.length;
  boat.hull = 70;
  boat.leak = 3;
  world.events.push({type: "enemy-bullet-boat-hit", targetBoat: boat.id});
  world.events.push({type: "enemy-bullet-boat-hit", targetBoat: boat.id});
  world.events.push({type: "enemy-bullet-boat-hit", targetBoat: boat.id});
  world.events.push({type: "enemy-bullet-boat-hit", targetBoat: boat.id});
  finishThreatIntelligence(world, frame, 0.05);
  assert.ok(boat.hull >= 70 && boat.hull <= 80);
  assert.ok(world.events.slice(beforeEvents).some(event => event.type === "enemy-bullet-near"));
});

test("ranged hostile actors eventually run out of ammunition and draw knives", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  startEnemyBoats(world, 4, {x: 210, y: 180});
  startHostileActors(world, 5, 99, {"threat-boat-1": 0});
  const actor = world.freeHostileActors.actors.find(candidate => candidate.weapon !== "knife");
  assert.ok(actor);
  actor.smartAmmo = 1;
  const frame = prepareThreatIntelligence(world);
  world.events.push({type: "enemy-gun-shot", gunnerId: actor.id});
  finishThreatIntelligence(world, frame, 0.05);
  assert.equal(actor.weapon, "knife");
  assert.equal(actor.switchedToKnife, true);
});

test("the heavy turret already fires physical projectiles at a player on shore", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 210, y: 58});
  for (const boat of world.boats) boat.sunk = true;
  const heavy = startHeavyPursuer(world, 1, {x: 92, y: 80}, 0);
  Object.assign(heavy, {x: 210, y: 145, turretHeading: 0, heading: 0, fireCooldown: 0});
  let damage = 0;
  run(updateHeavyPursuer, world, 5, {
    damagePlayer(_world, index, amount) {
      if (index === 0) damage += amount;
      return true;
    },
  });
  assert.ok(damage > 0);
});

test("enemy rammers still physically drive into player boats", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  startEnemyBoats(world, 4, world.boats[0]);
  const rammer = world.freeEnemyBoats.boats.find(boat => boat.role === "rammer");
  Object.assign(rammer, {x: world.boats[0].x, y: world.boats[0].y + 8, speed: 18, contactCooldown: 0});
  const hull = world.boats[0].hull;
  run(updateEnemyBoats, world, 0.1);
  assert.ok(world.boats[0].hull < hull);
});

test("core wraps existing combat modules with the intelligence director", async () => {
  const [core, menu] = await Promise.all([
    readFile(new URL("../public/src/free-roam-core-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-target-menu.js", import.meta.url), "utf8"),
  ]);
  assert.match(core, /prepareThreatIntelligence\(world\)/);
  assert.match(core, /finishThreatIntelligence\(world, threatIntelligence, safeDt\)/);
  assert.match(menu, /combatMenuActive\(world\)/);
});
