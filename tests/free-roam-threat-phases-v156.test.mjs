import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {updateHostileActors} from "../public/src/free-roam-hostile-actors.js";
import {
  finishThreatIntelligence,
  prepareThreatIntelligence,
  spawnFinalThreatWave,
} from "../public/src/free-roam-threat-intelligence.js";

function threatNotices(world) {
  return world.events.filter(event => event.type === "threat-player-down");
}

test("a solo death is not announced as two dead players", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  prepareThreatIntelligence(world);
  world.players[0].combat.alive = false;
  world.players[0].mode = "dead";
  prepareThreatIntelligence(world);
  assert.equal(threatNotices(world).length, 1);
  assert.match(threatNotices(world)[0].text, /Ты погиб/);
  assert.doesNotMatch(threatNotices(world)[0].text, /Оба игрока/);
  assert.deepEqual(threatNotices(world)[0].targets, [0]);
});

test("two present players produce one shared all-dead notice", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  prepareThreatIntelligence(world);
  for (const player of world.players) {
    player.combat.alive = false;
    player.mode = "dead";
  }
  prepareThreatIntelligence(world);
  assert.equal(threatNotices(world).length, 1);
  assert.match(threatNotices(world)[0].text, /Оба игрока погибли/);
  assert.deepEqual(threatNotices(world)[0].targets, [0, 1]);
});

test("knife enemies leave the shore and pursue a swimming player", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  Object.assign(world.players[0], {mode: "swim", activeBoat: null, x: 210, y: 128});
  const actor = {
    id: "water-knife-test",
    boatId: null,
    targetPlayer: 0,
    x: 210,
    y: 69,
    heading: 0,
    state: "foot",
    weapon: "knife",
    health: 58,
    maxHealth: 58,
    active: true,
    destroyed: false,
    elite: false,
    fireCooldown: 0,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: 0,
    strandedAt: 0,
    stepCooldown: 0,
  };
  world.freeHostileActors.active = true;
  world.freeHostileActors.actors = [actor];
  const before = Math.hypot(actor.x - world.players[0].x, actor.y - world.players[0].y);
  for (let index = 0; index < 80; index += 1) {
    const frame = prepareThreatIntelligence(world);
    updateHostileActors(world, 0.05, {damagePlayer() { return true; }});
    finishThreatIntelligence(world, frame, 0.05);
    world.time += 0.05;
  }
  const after = Math.hypot(actor.x - world.players[0].x, actor.y - world.players[0].y);
  assert.equal(actor.state, "swim");
  assert.ok(actor.y > 70);
  assert.ok(after < before);
});

test("the delayed level-five final phase creates a mixed physical landing once", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  world.freeThreatDirector = {active: true, level: 5, encounterId: 177};
  world.freeHeavyPursuer.boat = {id: "heavy-pursuer", role: "heavy", x: 210, y: 150, heading: 0, active: true, destroyed: false};
  world.freeHostileActors.active = true;
  world.freeHostileActors.actors = [];
  prepareThreatIntelligence(world);
  assert.equal(world.freeHostileActors.actors.length, 0);
  world.time += 4.6;
  prepareThreatIntelligence(world);
  assert.equal(world.freeHostileActors.actors.filter(actor => actor.active).length, 10);
  assert.ok(world.freeHostileActors.actors.some(actor => actor.weapon === "knife"));
  assert.ok(world.freeHostileActors.actors.some(actor => actor.weapon === "automatic"));
  const count = world.freeHostileActors.actors.length;
  world.time += 12;
  prepareThreatIntelligence(world);
  assert.equal(world.freeHostileActors.actors.length, count);
  assert.equal(world.events.filter(event => event.type === "contract-threat-final-wave").length, 1);
});

test("cooperative final phase caps at fourteen distributed fighters", () => {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, true];
  world.freeThreatDirector = {active: true, level: 5, encounterId: 188};
  world.freeHeavyPursuer.boat = {id: "heavy-pursuer", role: "heavy", x: 210, y: 150, heading: 0, active: true, destroyed: false};
  world.freeHostileActors.active = true;
  world.freeHostileActors.actors = [];
  assert.equal(spawnFinalThreatWave(world), 14);
  assert.equal(world.freeHostileActors.actors.length, 14);
  assert.deepEqual(new Set(world.freeHostileActors.actors.map(actor => actor.targetPlayer)), new Set([0, 1]));
});

test("enemy knife hits use the existing centered combat-impact audio event", () => {
  const world = createFreeWorld();
  const frame = prepareThreatIntelligence(world);
  world.events.push({type: "enemy-knife-hit", targets: [0], targetPlayer: 0, weapon: "knife", x: world.players[0].x, y: world.players[0].y});
  finishThreatIntelligence(world, frame, 0.05);
  const event = world.events.at(-1);
  assert.equal(event.type, "combat-hit");
  assert.equal(event.originalType, "enemy-knife-hit");
  assert.equal(event.centeredImpact, true);
});
