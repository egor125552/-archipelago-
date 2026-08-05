import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld, setPlayerPresence} from "../public/src/free-roam-core-v6.js";
import {
  ELITE_BOMB_RELOAD_SECONDS,
  ensureEliteBoatBoss,
  startEliteBoatBoss,
  updateEliteBoatBoss,
} from "../public/src/free-roam-elite-boat.js";
import {activeEntitySnapshots} from "../public/src/free-roam-developer-log-model-v2.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";

function setupWorld() {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  world.freeThreatDirector ||= {graceUntil: [0, 0]};
  world.freeThreatDirector.graceUntil ||= [0, 0];
  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, false);
  const player = world.players[0];
  const boat = world.boats[0];
  boat.id = 0;
  boat.owner = 0;
  boat.driver = 0;
  boat.x = 190;
  boat.y = 185;
  boat.heading = 90;
  boat.speed = 12;
  player.mode = "boat";
  player.activeBoat = 0;
  player.x = boat.x;
  player.y = boat.y;
  const state = startEliteBoatBoss(world, 77, {x: 210, y: 180}, 0);
  state.phase = "boat-combat";
  state.boat.x = 305;
  state.boat.y = 185;
  state.boat.heading = -90;
  state.boat.speed = 0;
  return {world, state};
}

test("the abandoned-player-boat audio extension patches the active v44 audio class", async () => {
  const boatAudio = await readFile(new URL("../public/src/free-roam-player-boat-audio-v1.js", import.meta.url), "utf8");
  const quality = await readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  assert.match(boatAudio, /free-roam-audio-v5\.js\?v=44/);
  assert.match(quality, /free-roam-player-boat-audio-v1\.js\?v=2/);
});

test("restored object-shaped boss collections are migrated centrally", () => {
  const {world, state} = setupWorld();
  state.boat.armorLayers = {};
  state.boat.turrets = {};
  ensureEliteBoatBoss(world);
  assert.equal(state.boat.armorLayers.length, 3);
  assert.equal(state.boat.turrets.length, 2);
  assert.deepEqual(state.boat.turrets.map(turret => turret.side), ["port", "starboard"]);
});

test("respawn grace prevents target acquisition, bullets and bomb-bay opening", () => {
  const {world, state} = setupWorld();
  world.freeThreatDirector.graceUntil[0] = world.time + 2;
  for (const turret of state.boat.turrets) turret.fireCooldown = 0;
  for (let index = 0; index < 15; index += 1) updateEliteBoatBoss(world, 0.1, {});
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.bombBayState, "closed");
  assert.equal(world.events.some(event => event.type === "elite-turret-windup"), false);
  world.time += 2.1;
  for (let index = 0; index < 12; index += 1) updateEliteBoatBoss(world, 0.1, {});
  assert.ok(world.events.some(event => event.type === "elite-turret-shot"));
});

test("left and right physical turrets bracket different halves of the same moving boat", () => {
  const {world, state} = setupWorld();
  state.bombCooldown = 99;
  for (const turret of state.boat.turrets) turret.fireCooldown = 0;
  for (let index = 0; index < 12; index += 1) updateEliteBoatBoss(world, 0.1, {});
  const shotEvents = world.events.filter(event => event.type === "elite-turret-shot");
  const sections = new Set(shotEvents.map(event => event.aimSection));
  assert.equal(sections.has("rear"), true);
  assert.equal(sections.has("front"), true);
  assert.ok(shotEvents.every(event => Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.heading)));
});

test("the physical bomb bay opens, fires three bombs and reloads for five seconds", () => {
  const {world, state} = setupWorld();
  for (const turret of state.boat.turrets) turret.destroyed = true;
  state.bombCooldown = 0;
  for (let index = 0; index < 25; index += 1) updateEliteBoatBoss(world, 0.1, {});
  assert.equal(world.events.filter(event => event.type === "elite-bomb-launch").length, 3);
  assert.ok(world.events.some(event => event.type === "elite-bomb-bay-opening"));
  assert.ok(world.events.some(event => event.type === "elite-bomb-salvo"));
  assert.ok(world.events.some(event => event.type === "elite-bomb-bay-closing"));
  assert.equal(ELITE_BOMB_RELOAD_SECONDS, 5);
  assert.ok(state.bombCooldown > 3 && state.bombCooldown <= 5);
  assert.equal(state.salvoRemaining, 0);
});

test("the faster movement remains physical and bounded", () => {
  const {world, state} = setupWorld();
  world.boats[0].x = 40;
  world.boats[0].y = 110;
  for (const turret of state.boat.turrets) turret.destroyed = true;
  state.bombCooldown = 99;
  const before = {x: state.boat.x, y: state.boat.y};
  for (let index = 0; index < 80; index += 1) updateEliteBoatBoss(world, 0.05, {});
  assert.notDeepEqual({x: state.boat.x, y: state.boat.y}, before);
  assert.ok(state.boat.speed > 0 && state.boat.speed <= 23);
  assert.ok(state.boat.x >= 15 && state.boat.x <= 405);
  assert.ok(state.boat.y >= 84 && state.boat.y <= 305);
  assert.notEqual(state.boat.movementMode, "holding-fire");
});

test("replication and the developer journal expose the elite boat, turrets and bomb bay", () => {
  const {world, state} = setupWorld();
  state.bombBayState = "opening";
  state.bombCooldown = 4.7;
  state.boat.bombBayState = "opening";
  state.boat.bombCooldown = 4.7;
  const replica = replicatedFreeWorld(world);
  assert.equal(replica.freeEliteBoatBoss.bombBayState, "opening");
  assert.equal(replica.freeEliteBoatBoss.boat.turrets.length, 2);
  const snapshots = activeEntitySnapshots(world);
  const elite = snapshots.find(entity => entity.kind === "elite-boat");
  const playerBoat = snapshots.find(entity => entity.kind === "player-boat");
  assert.ok(elite);
  assert.equal(elite.turrets.length, 2);
  assert.equal(elite.bombBayState, "opening");
  assert.ok(playerBoat, "the journal must retain the player's physical boat outside the water");
});
