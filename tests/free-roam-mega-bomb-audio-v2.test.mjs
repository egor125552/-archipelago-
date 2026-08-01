import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import test from "node:test";

import {ensureMegaBombState, MEGA_BOMB_START_AMMO} from "../src/free-roam-mega-bomb.js";

const assets = [
  "../public/audio/mega-bomb-flight-real-v1.mp3",
  "../public/audio/mega-bomb-explosion-real-v1.mp3",
];

test("real mega-bomb flight and explosion recordings ship as MP3 assets", async () => {
  for (const relative of assets) {
    const url = new URL(relative, import.meta.url);
    const info = await stat(url);
    const head = await readFile(url).then(buffer => buffer.subarray(0, 3).toString("ascii"));
    assert.ok(info.size > 10_000, `${relative} must contain a real recording`);
    assert.ok(head === "ID3" || head.charCodeAt(0) === 0xff, `${relative} must be MP3 data`);
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
