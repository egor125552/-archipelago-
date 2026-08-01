import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import test from "node:test";

import {ensureMegaBombState, MEGA_BOMB_START_AMMO} from "../src/free-roam-mega-bomb.js";

const assets = [
  "../public/audio/mega-bomb-flight-real-v1.mp3",
  "../public/audio/mega-bomb-explosion-real-v1.mp3",
];
const killParts = [
  "../public/audio/enemy-killed-v1.part-00.b64",
  "../public/audio/enemy-killed-v1.part-01.b64",
  "../public/audio/enemy-killed-v1.part-02.b64",
  "../public/audio/enemy-killed-v1.part-03.b64",
];

test("real mega-bomb and kill-confirmation recordings ship as MP3 assets", async () => {
  for (const relative of assets) {
    const url = new URL(relative, import.meta.url);
    const info = await stat(url);
    const head = await readFile(url).then(buffer => buffer.subarray(0, 3).toString("ascii"));
    assert.ok(info.size > 10_000, `${relative} must contain a real recording`);
    assert.ok(head === "ID3" || head.charCodeAt(0) === 0xff, `${relative} must be MP3 data`);
  }
  const encoded = (await Promise.all(killParts.map(relative => readFile(new URL(relative, import.meta.url), "utf8")))).join("");
  const killBytes = Buffer.from(encoded, "base64");
  assert.ok(killBytes.length > 10_000, "kill confirmation must contain the supplied real recording");
  assert.ok(killBytes.subarray(0, 3).toString("ascii") === "ID3" || killBytes[0] === 0xff);
});

test("old fifty-charge test worlds migrate once to one hundred charges", () => {
  const world = {
    players: [
      {combat: {megaBombAmmo: 7, megaBombCooldown: 0, weapons: {}}},
      {combat: {megaBombAmmo: 50, megaBombCooldown: 0, weapons: {}}},
    ],
    freeMegaBombs: {projectiles: [], nextId: 1, ammoVersion: 2},
  };
  ensureMegaBombState(world);
  assert.equal(MEGA_BOMB_START_AMMO, 100);
  assert.deepEqual(world.players.map(player => player.combat.megaBombAmmo), [100, 100]);
  world.players[0].combat.megaBombAmmo = 87;
  ensureMegaBombState(world);
  assert.equal(world.players[0].combat.megaBombAmmo, 87, "migration must not refill repeatedly");
});
