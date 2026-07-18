import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  createFreeWorld,
  drainEvents,
  playerStatus,
  setPlayerInput,
  setPlayerPresence,
  snapshotWorld,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";

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
  run(world, hold);
  setPlayerInput(world, playerIndex, {[control]: false});
  return run(world, 0.08);
}

function activity(world) {
  return world.freeActivities;
}

test("a new free world contains audible salvage and treats the second player as absent until connected", () => {
  const world = createFreeWorld();
  assert.equal(world.version, 6);
  assert.deepEqual(activity(world).presence, [true, false]);
  assert.ok(activity(world).crates.length >= 6);
  assert.ok(activity(world).crates.some(crate => crate.rarity === "rare"));
  assert.ok(activity(world).crates.every(crate => Number.isFinite(crate.x) && Number.isFinite(crate.y)));
  assert.match(playerStatus(world, 0), /Ближайший груз/);
  assert.match(playerStatus(world, 0), /ждём второго игрока/i);
});

test("a player can pick up a plate crate, stow it, deliver it and improve the boat", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const boat = world.boats[0];
  const crate = activity(world).crates.find(candidate => candidate.kind === "plates");
  assert.ok(crate);

  player.mode = "foot";
  player.activeBoat = null;
  player.x = crate.x;
  player.y = crate.y;
  pulse(world, 0, "action");
  assert.equal(crate.carriedBy, 0);

  player.x = boat.x;
  player.y = boat.y;
  pulse(world, 0, "action");
  assert.equal(crate.stowedBoat, 0);
  assert.equal(boat.cargo.length, 1);

  const patchesBefore = boat.repairPatches;
  boat.x = 200;
  boat.y = 82;
  boat.speed = 0;
  run(world, 1.2);
  assert.ok(boat.repairPatches > patchesBefore);
  assert.equal(boat.cargo.length, 0);
  assert.ok(activity(world).score[0] > 0);
});

test("cargo weight slows a loaded boat without stopping it", () => {
  const empty = createFreeWorld();
  const loaded = createFreeWorld();
  loaded.boats[0].cargo = ["test-heavy-a", "test-heavy-b", "test-heavy-c"];
  activity(loaded).crates.push(
    {id: "test-heavy-a", kind: "valuable", weight: 4, stowedBoat: 0, state: "stowed"},
    {id: "test-heavy-b", kind: "valuable", weight: 4, stowedBoat: 0, state: "stowed"},
    {id: "test-heavy-c", kind: "valuable", weight: 4, stowedBoat: 0, state: "stowed"},
  );
  setPlayerInput(empty, 0, {up: true});
  setPlayerInput(loaded, 0, {up: true});
  run(empty, 4);
  run(loaded, 4);
  assert.ok(Math.abs(loaded.boats[0].speed) < Math.abs(empty.boats[0].speed) - 0.5);
  assert.ok(Math.abs(loaded.boats[0].speed) > 2);
});

test("short and held X attacks are different, and a heavy hit knocks the opponent down", () => {
  const world = createFreeWorld();
  setPlayerPresence(world, 1, true);
  const a = world.players[0];
  const b = world.players[1];
  Object.assign(a, {mode: "foot", activeBoat: null, x: 190, y: 50, heading: 90});
  Object.assign(b, {mode: "foot", activeBoat: null, x: 193, y: 50, heading: 270});

  const healthBefore = b.combat.health;
  pulse(world, 0, "attack", 0.12);
  assert.ok(b.combat.health < healthBefore);
  assert.equal(b.combat.knockedDown, false);

  setPlayerInput(world, 0, {attack: true});
  run(world, 0.72);
  setPlayerInput(world, 0, {attack: false});
  const events = run(world, 0.08);
  assert.equal(b.combat.knockedDown, true);
  assert.ok(events.some(event => event.type === "combat-heavy-hit"));
});

test("a rare automatic fires while held and can destroy the marauder", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const marauder = activity(world).marauder;
  const stolenCrate = activity(world).crates.find(crate => crate.kind === "valuable");
  Object.assign(player, {mode: "swim", activeBoat: null, x: 190, y: 100, heading: 90});
  Object.assign(marauder, {x: 220, y: 100, hull: 24, active: true, destroyed: false, cargo: [stolenCrate.id]});
  Object.assign(stolenCrate, {state: "marauder", carriedBy: null, stowedBoat: null});
  player.combat.weapons.automatic = true;
  player.combat.ammo = 30;
  player.combat.equipped = "automatic";

  setPlayerInput(world, 0, {attack: true});
  const events = run(world, 1);
  setPlayerInput(world, 0, {attack: false});
  run(world, 0.1);
  assert.ok(events.some(event => event.type === "gun-shot"));
  assert.ok(events.some(event => event.type === "marauder-destroyed"));
  assert.equal(marauder.destroyed, true);
  assert.equal(marauder.cargo.length, 0);
  assert.equal(stolenCrate.state, "world");
  assert.ok(activity(world).crates.some(crate => crate.source === "marauder" && crate.rarity === "rare"));
});

test("death drops carried cargo, leaves the boat and respawns the player at the dock after eight seconds", () => {
  const world = createFreeWorld();
  setPlayerPresence(world, 1, true);
  const player = world.players[0];
  const boat = world.boats[0];
  const crate = activity(world).crates[0];
  Object.assign(player, {mode: "foot", activeBoat: null, x: 180, y: 50});
  crate.state = "carried";
  crate.carriedBy = 0;
  player.combat.carriedCrate = crate.id;
  player.combat.health = 1;

  const boatPosition = {x: boat.x, y: boat.y};
  player.combat.pendingDamage = 5;
  const deathEvents = run(world, 0.1);
  assert.equal(player.combat.alive, false);
  assert.equal(crate.carriedBy, null);
  assert.equal(crate.state, "world");
  assert.ok(deathEvents.some(event => event.type === "player-death"));

  run(world, 7.7);
  assert.equal(player.combat.alive, false);
  const respawnEvents = run(world, 0.4);
  assert.equal(player.combat.alive, true);
  assert.equal(player.combat.health, 100);
  assert.equal(player.mode, "foot");
  assert.ok(player.y < 72);
  assert.deepEqual({x: boat.x, y: boat.y}, boatPosition);
  assert.ok(respawnEvents.some(event => event.type === "player-respawn"));
});

test("the marauder targets loaded boats, can steal cargo and remains serializable", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  const crate = activity(world).crates[0];
  crate.state = "stowed";
  crate.stowedBoat = 0;
  crate.carriedBy = null;
  boat.cargo.push(crate.id);
  Object.assign(activity(world).marauder, {
    x: boat.x + 3,
    y: boat.y + 3,
    active: true,
    destroyed: false,
    stealCooldown: 0,
  });

  const events = run(world, 2);
  assert.ok(events.some(event => event.type === "marauder-steal"));
  assert.equal(boat.cargo.includes(crate.id), false);
  assert.doesNotThrow(() => JSON.stringify(snapshotWorld(world)));
});

test("the release UI exposes accessible combat controls and local MP3 assets", async () => {
  const [html, client, audio] = await Promise.all([
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v5.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="attackButton"/);
  assert.match(html, /aria-keyshortcuts="X"/);
  assert.match(html, /id="weaponButton"/);
  assert.match(html, /aria-keyshortcuts="Z"/);
  assert.match(client, /free-roam-core-v6\.js/);
  assert.match(client, /bindHold\(\$\("attackButton"\), "attack", 90\)/);
  assert.match(audio, /heartbeat-fast\.mp3/);
  assert.match(audio, /death-full\.mp3/);
  assert.match(audio, /smoothInjuryMix/);
});
