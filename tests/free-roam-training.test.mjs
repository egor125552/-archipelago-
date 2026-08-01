import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";

import {
  applyServerFreeInput,
  consumeCompletedTrainingEpisodes,
  createServerFreeRoom,
  finishServerTrainingBattle,
  persistedWorldForServerRoom,
  setServerFreePresence,
  startServerTrainingBattle,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {createStoredZip, crc32} from "../src/training-archive.js";


test("quick training invokes the production threat encounter and restores the ordinary world", () => {
  const server = createServerFreeRoom(1_000);
  setServerFreePresence(server, "captain", true);
  const ordinary = structuredClone(server.world);

  const status = startServerTrainingBattle(server, 4, true, 1_100);
  assert.equal(status.trainingActive, true);
  assert.equal(status.battleActive, true);
  assert.equal(status.level, 4);
  assert.equal(server.world.freeThreatDirector.active, true);
  assert.equal(server.world.freeThreatDirector.level, 4);
  assert.equal(server.world.freeContracts.encounterActive, true);
  assert.equal(server.world.players[0].combat.weapons.automatic, true);
  assert.ok(server.world.players[0].combat.ammo >= 180);
  assert.equal(server.world.boats[0].hull, 100);
  assert.equal(server.world.boats[0].water, 0);

  const persisted = persistedWorldForServerRoom(server);
  assert.equal(persisted.freeThreatDirector?.active ?? false, ordinary.freeThreatDirector?.active ?? false);
  assert.equal(persisted.freeActivities.delivered[0], ordinary.freeActivities.delivered[0]);

  applyServerFreeInput(server, "captain", {up: true, right: true, attack: true}, 1);
  tickServerFreeRoom(server, 1_350);
  tickServerFreeRoom(server, 1_600);

  finishServerTrainingBattle(server, "manual", {restore: true, now: 1_700});
  const episodes = consumeCompletedTrainingEpisodes(server);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].level, 4);
  assert.equal(episodes[0].mode, "quick");
  assert.equal(episodes[0].outcome, "manual");
  assert.ok(episodes[0].frames.length >= 2);
  assert.equal(server.world.freeActivities.delivered[0], ordinary.freeActivities.delivered[0]);
  assert.equal(server.world.freeActivities.credits, ordinary.freeActivities.credits);
  assert.equal(server.world.boats[0].hull, ordinary.boats[0].hull);
});


test("training archive creates a readable stored ZIP envelope", () => {
  const data = new TextEncoder().encode("hello training\n");
  assert.equal(crc32(data), 0xce76d6c3);
  const zip = createStoredZip([{name: "battle.jsonl", data}], new Date("2026-08-01T00:00:00Z"));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
});


test("browser training code stores preferences but never stores world or battle data", async () => {
  const source = await readFile(new URL("../public/src/free-roam-training-client-v1.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sessionStorage/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(world|battle|episode|frame)/i);
  assert.match(source, /\/api\/training\/archive/);
  assert.match(source, /\/api\/training\/start/);
});
