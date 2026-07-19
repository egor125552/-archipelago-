import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {
  injuryLowpassFrequency,
  injuryMixTarget,
} from "../public/src/free-roam-combat-recovery.js";

function run(world, seconds, dt = 0.02) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

function tap(world, playerIndex, control, hold = 0.04) {
  setPlayerInput(world, playerIndex, {[control]: true});
  const events = run(world, hold);
  setPlayerInput(world, playerIndex, {[control]: false});
  events.push(...run(world, 0.04));
  return events;
}

function putPlayersOnShore(world, metres = 5) {
  setPlayerPresence(world, 1, true);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 45, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 180 + metres, y: 45, heading: 270});
}

test("the attacker hears the impact but not the victim health or victim knockdown phrase", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world);

  const hitEvents = tap(world, 0, "attack");
  const impact = hitEvents.find(event => event.type === "combat-hit");
  const health = hitEvents.find(event => event.type === "combat-health");

  assert.ok(impact?.targets.includes(0));
  assert.equal(impact.text, "");
  assert.deepEqual(health?.targets, [1]);
  assert.match(health?.text || "", /здоровье/i);

  run(world, 0.12);
  world.players[1].combat.health = 16;
  world.players[1].combat.lastDamageAt = world.time;
  const criticalEvents = tap(world, 0, "attack");
  const knockdown = criticalEvents.find(event => event.type === "player-knockdown");
  const notice = criticalEvents.find(event => event.type === "player-knockdown-notice");

  assert.ok(knockdown?.targets.includes(0));
  assert.equal(knockdown.text, "");
  assert.deepEqual(notice?.targets, [1]);
  assert.match(notice?.text || "", /тебя сбили/i);
});

test("a healthy heavy hit does not knock a player down", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world);

  setPlayerInput(world, 0, {attack: true});
  run(world, 0.5);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.04);

  assert.equal(world.players[1].combat.health, 80);
  assert.equal(world.players[1].combat.knockedDown, false);
});

test("a hit that leaves seven health causes the real critical knockdown", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world);
  world.players[1].combat.health = 16;
  world.players[1].combat.lastDamageAt = world.time;

  const events = tap(world, 0, "attack");

  assert.equal(world.players[1].combat.health, 7);
  assert.equal(world.players[1].combat.knockedDown, true);
  assert.ok(events.some(event => event.type === "player-knockdown"));
});

test("full muffling starts at critical health and then follows health recovery exactly", () => {
  assert.equal(injuryLowpassFrequency(1), 50);
  assert.ok(injuryMixTarget({alive: true, health: 80, stun: 100, knockedDown: true}) < 0.3);
  assert.equal(injuryMixTarget({alive: true, health: 7, stun: 0, knockedDown: false}), 1);

  const world = createFreeWorld();
  const combat = world.players[0].combat;
  Object.assign(combat, {
    health: 7,
    knockedDown: false,
    knockdownRemaining: 0,
    injuryMix: 1,
    lastDamageAt: -10,
  });
  world.time = 10;

  run(world, 0.1);

  assert.ok(combat.health > 7);
  assert.ok(combat.injuryMix < 1);
  assert.ok(Math.abs(combat.injuryMix - injuryMixTarget(combat)) < 0.001);
});
