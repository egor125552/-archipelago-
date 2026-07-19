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
import {COMBAT_TUNING} from "../public/src/free-roam-combat-tuning.js";

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

function putPlayersOnShore(world, metres, heading = 90) {
  setPlayerPresence(world, 1, true);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 130, y: 45, heading});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 130 + metres, y: 45, heading: 270});
}

function equipAutomatic(world, playerIndex = 0) {
  const combat = world.players[playerIndex].combat;
  combat.weapons.automatic = true;
  combat.equipped = "automatic";
  combat.ammo = 48;
}

test("F pulls a player into a free boat from just under thirteen metres", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  boat.driver = null;
  Object.assign(player, {
    mode: "foot",
    activeBoat: null,
    x: boat.x + 12.9,
    y: boat.y,
  });

  const events = tap(world, 0, "action");

  assert.equal(player.mode, "boat");
  assert.equal(player.activeBoat, boat.id);
  assert.equal(boat.driver, 0);
  assert.ok(events.some(event => event.type === "enter" && /лодк/i.test(event.text)));
});

test("F does not teleport a player to a boat outside the thirteen metre assist", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  boat.driver = null;
  Object.assign(player, {
    mode: "foot",
    activeBoat: null,
    x: boat.x + 13.2,
    y: boat.y,
  });

  tap(world, 0, "action");

  assert.notEqual(player.mode, "boat");
  assert.equal(boat.driver, null);
});

test("full knockdown muffling reaches the requested fifty to one hundred hertz", () => {
  const frequency = injuryLowpassFrequency(1);

  assert.ok(frequency >= 50);
  assert.ok(frequency <= 100);
});

test("a critical heavy punch leaves the target down for substantially longer", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 5);
  world.players[1].combat.health = 27;
  world.players[1].combat.lastDamageAt = world.time;
  setPlayerInput(world, 0, {attack: true});
  run(world, 0.5);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.04);

  assert.equal(world.players[1].combat.knockedDown, true);
  run(world, 8);
  assert.equal(world.players[1].combat.knockedDown, true);
  run(world, 5);
  assert.equal(world.players[1].combat.knockedDown, false);
});

test("a quick fist strike reaches a target twelve and a half metres away", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 12.5);

  tap(world, 0, "attack");

  assert.ok(world.players[1].combat.health < 100);
});

test("two rapid fist taps both land instead of the second being swallowed", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 5);

  tap(world, 0, "attack");
  run(world, 0.06);
  tap(world, 0, "attack");

  assert.equal(world.players[1].combat.health, 82);
});

test("an automatic hits a nearby side target that is already in melee reach", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 10, 0);
  equipAutomatic(world);

  setPlayerInput(world, 0, {attack: true});
  const events = run(world, 0.08);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.04);

  assert.equal(world.players[1].combat.health, 89);
  assert.ok(events.some(event => event.type === "gun-hit"));
});

test("an automatic can hit along its aim line across most of the map without extra damage", () => {
  const world = createFreeWorld();
  setPlayerPresence(world, 1, true);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 20, y: 45, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 360, y: 45, heading: 270});
  equipAutomatic(world);

  setPlayerInput(world, 0, {attack: true});
  const events = run(world, 0.08);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.04);

  assert.equal(world.players[1].combat.health, 89);
  assert.ok(events.some(event => event.type === "gun-hit"));
});

test("the attacker is told when an automatic defeats the other player", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world, 10);
  equipAutomatic(world);
  world.players[1].combat.health = 5;

  setPlayerInput(world, 0, {attack: true});
  const events = run(world, 0.08);

  assert.ok(events.some(event => (
    event.type === "player-defeated"
    && event.targets.length === 1
    && event.targets[0] === 0
    && /игрок повержен/i.test(event.text)
  )));
});

test("automatic shots and impacts use their long-range high-gain audio tuning", async () => {
  const source = await readFile(new URL("../public/src/free-roam-audio-v5.js", import.meta.url), "utf8");

  assert.ok(COMBAT_TUNING.automaticAudibleRange >= 700);
  assert.ok(COMBAT_TUNING.automaticImpactRange >= 300);
  assert.ok(COMBAT_TUNING.automaticShotGain >= 0.85);
  assert.ok(COMBAT_TUNING.automaticImpactGain >= 1);
  assert.match(source, /eventPanAndGain\(event, COMBAT_TUNING\.automaticAudibleRange\)/);
  assert.match(source, /eventPanAndGain\(event, COMBAT_TUNING\.automaticImpactRange\)/);
  assert.match(source, /gain: COMBAT_TUNING\.automaticShotGain \* shotSpatial\.gain/);
});

test("the production combat module chain uses explicit cache generations", async () => {
  const [html, entry, core, combat, audio] = await Promise.all([
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-core-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-combat.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v5.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /free-roam-v4\.js\?v=30/);
  assert.match(entry, /free-roam-core-v6\.js\?v=30/);
  assert.match(entry, /free-roam-audio-v5\.js\?v=30/);
  assert.match(core, /free-roam-boarding-assist\.js\?v=29/);
  assert.match(core, /free-roam-combat\.js\?v=30/);
  assert.match(combat, /free-roam-combat-recovery\.js\?v=30/);
  assert.match(combat, /free-roam-combat-tuning\.js\?v=30/);
  assert.match(audio, /free-roam-combat-recovery\.js\?v=30/);
  assert.match(audio, /free-roam-combat-tuning\.js\?v=30/);
});
