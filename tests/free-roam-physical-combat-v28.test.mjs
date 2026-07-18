import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {injuryLowpassFrequency} from "../public/src/free-roam-combat-recovery.js";

function run(world, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

function pulse(world, playerIndex, control, hold = 0.08) {
  setPlayerInput(world, playerIndex, {[control]: true});
  const events = run(world, hold);
  setPlayerInput(world, playerIndex, {[control]: false});
  events.push(...run(world, 0.08));
  return events;
}

function putPlayersOnShore(world, distance = 5) {
  setPlayerPresence(world, 1, true);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 190, y: 50, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 190 + distance, y: 50, heading: 270});
}

test("a fist attack reaches a nearby physical player at nine metres", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 9);

  const healthBefore = world.players[1].combat.health;
  pulse(world, 0, "attack", 0.12);

  assert.ok(world.players[1].combat.health < healthBefore);
});

test("a knocked-down player cannot crawl while the stun is active", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 4);
  setPlayerInput(world, 0, {attack: true});
  run(world, 0.7);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.08);
  const target = world.players[1];
  assert.equal(target.combat.knockedDown, true);
  const startX = target.x;

  setPlayerInput(world, 1, {right: true, run: true});
  run(world, 1);

  assert.equal(target.x, startX);
});

test("three ordinary paced fist hits still produce a real stun", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 4);

  pulse(world, 0, "attack", 0.12);
  run(world, 0.45);
  pulse(world, 0, "attack", 0.12);
  run(world, 0.45);
  const events = pulse(world, 0, "attack", 0.12);

  assert.equal(world.players[1].combat.knockedDown, true);
  assert.ok(events.some(event => event.type === "player-knockdown"));
});

test("a knocked-down player cannot use F until getting back up", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "plates");
  Object.assign(player, {mode: "foot", activeBoat: null, x: crate.x, y: crate.y});
  player.combat.knockedDown = true;
  player.combat.knockdownRemaining = 2;

  const events = pulse(world, 0, "action");

  assert.equal(crate.state, "world");
  assert.ok(events.some(event => event.type === "action-denied" && /оглушён/i.test(event.text)));
});

test("health waits after the last hit, then smoothly recovers to full", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 4);
  pulse(world, 0, "attack", 0.12);
  const target = world.players[1];
  const damagedHealth = target.combat.health;

  run(world, 4.5);
  assert.equal(target.combat.health, damagedHealth);

  run(world, 4);
  assert.ok(target.combat.health > damagedHealth);
  assert.ok(target.combat.health < 100);

  run(world, 30);
  assert.equal(target.combat.health, 100);
  assert.ok(target.combat.injuryMix < 0.02);
});

test("the stun filter gradually opens as injury fades", () => {
  assert.ok(injuryLowpassFrequency(1) < injuryLowpassFrequency(0.5));
  assert.ok(injuryLowpassFrequency(0.5) < injuryLowpassFrequency(0));
  assert.equal(injuryLowpassFrequency(0), 12000);
});

test("players are solid and announce one nearby living player instead of passing through", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 8);
  setPlayerInput(world, 0, {right: true});
  setPlayerInput(world, 1, {left: true});

  const events = run(world, 2);
  const metres = Math.hypot(
    world.players[1].x - world.players[0].x,
    world.players[1].y - world.players[0].y,
  );

  assert.ok(metres >= 2.8);
  assert.equal(events.filter(event => event.type === "player-nearby" && event.targets.includes(0)).length, 1);
  assert.ok(events.some(event => event.type === "player-contact"));
});

test("a player cannot walk through a boat or the active pursuer", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[1];
  Object.assign(player, {mode: "swim", activeBoat: null, x: 190, y: 100});
  Object.assign(boat, {x: 195, y: 100, speed: 0, driver: null});
  run(world, 0.1);
  assert.ok(Math.hypot(player.x - boat.x, player.y - boat.y) >= 7.2);

  const pursuer = world.freeActivities.marauder;
  Object.assign(player, {x: 210, y: 120});
  Object.assign(pursuer, {x: 215, y: 120, active: true, destroyed: false, speed: 0});
  run(world, 0.1);
  assert.ok(Math.hypot(player.x - pursuer.x, player.y - pursuer.y) >= 8.19);
});

test("a carried crate can be handed in manually on foot at the dock", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "plates");
  Object.assign(player, {mode: "foot", activeBoat: null, x: 210, y: 65});
  Object.assign(crate, {state: "carried", carriedBy: 0, stowedBoat: null, x: player.x, y: player.y});
  player.combat.carriedCrate = crate.id;

  const events = pulse(world, 0, "action");

  assert.equal(player.combat.carriedCrate, null);
  assert.equal(crate.state, "delivered");
  assert.ok(events.some(event => event.type === "cargo-delivered" && /вручную/i.test(event.text)));
});

test("approaching a loaded enemy boat clearly explains how to steal its cargo", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 20);
  const boat = world.boats[0];
  const thief = world.players[1];
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "valuable");
  Object.assign(boat, {x: 210, y: 84, driver: null, cargo: [crate.id]});
  Object.assign(crate, {state: "stowed", stowedBoat: boat.id, carriedBy: null});
  Object.assign(thief, {x: 216, y: 72});

  const events = run(world, 0.2);

  assert.ok(events.some(event => event.type === "cargo-theft-ready" && event.targets.includes(1)));
  assert.match(events.find(event => event.type === "cargo-theft-ready").text, /нажми F/i);
});

test("the interface explicitly shows that a player is stunned", async () => {
  const source = await readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");
  assert.match(source, /combat\.knockedDown \? "оглушён"/);
  assert.match(source, /Сбит с ног/);
});
