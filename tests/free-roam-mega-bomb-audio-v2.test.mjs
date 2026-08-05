import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import test from "node:test";

import {ensureMegaBombState, MEGA_BOMB_START_AMMO} from "../src/free-roam-mega-bomb.js";

const assets = [
  ["../public/audio/mega-bomb-flight-real-v1.mp3", 10_000],
  ["../public/audio/mega-bomb-explosion-v12.mp3", 50_000],
  ["../public/audio/enemy-killed-v5.mp3", 1_000],
];

test("mega-bomb and kill recordings ship as complete direct MP3 files", async () => {
  for (const [relative, minimum] of assets) {
    const url = new URL(relative, import.meta.url);
    const info = await stat(url);
    const bytes = await readFile(url);
    assert.ok(info.size > minimum, `${relative} must contain a complete recording`);
    const id3 = bytes.subarray(0, 3).toString("ascii") === "ID3";
    const frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    assert.ok(id3 || frame, `${relative} must be MP3 data`);
  }
});

test("legacy ammo worlds migrate once to the current twenty-five-charge stock", () => {
  const world = {
    players: [
      {combat: {megaBombAmmo: 7, megaBombCooldown: 0, weapons: {}}},
      {combat: {megaBombAmmo: 50, megaBombCooldown: 0, weapons: {}}},
    ],
    freeMegaBombs: {projectiles: [], nextId: 1, ammoVersion: 2},
  };
  ensureMegaBombState(world);
  assert.equal(MEGA_BOMB_START_AMMO, 25);
  assert.deepEqual(world.players.map(player => player.combat.megaBombStock), [25, 25]);
  world.players[0].combat.megaBombStock = 17;
  ensureMegaBombState(world);
  assert.equal(world.players[0].combat.megaBombStock, 17, "migration must not refill repeatedly");
  assert.equal(world.players[0].combat.megaBombAmmo, 17);
});
