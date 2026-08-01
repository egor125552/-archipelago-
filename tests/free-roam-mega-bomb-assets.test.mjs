import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import test from "node:test";

import {ensureMegaBombState, MEGA_BOMB_START_AMMO} from "../src/free-roam-mega-bomb.js";

const assets = [
  "../public/audio/mega-bomb-real-v2/flight.mp3",
  "../public/audio/mega-bomb-real-v2/explosion.mp3",
];

test("real mega-bomb recordings are shipped as separate non-empty MP3 assets", async () => {
  for (const path of assets) {
    const url = new URL(path, import.meta.url);
    const info = await stat(url);
    const bytes = await readFile(url);
    const head = bytes.subarray(0, 3).toString("ascii");
    assert.ok(info.size > 8_000, `${path} must contain a real recording`);
    assert.ok(head === "ID3" || bytes[0] === 0xff, `${path} must be MP3 data`);
  }
});

test("old ten-charge test worlds migrate once to fifty charges", () => {
  const world = {
    players: [
      {combat: {megaBombAmmo: 7, megaBombCooldown: 0, weapons: {}}},
      {combat: {megaBombAmmo: 10, megaBombCooldown: 0, weapons: {}}},
    ],
    freeMegaBombs: {projectiles: [], nextId: 1},
  };
  ensureMegaBombState(world);
  assert.equal(MEGA_BOMB_START_AMMO, 50);
  assert.deepEqual(world.players.map(player => player.combat.megaBombAmmo), [50, 50]);
  world.players[0].combat.megaBombAmmo = 43;
  ensureMegaBombState(world);
  assert.equal(world.players[0].combat.megaBombAmmo, 43, "migration must not refill repeatedly");
});
