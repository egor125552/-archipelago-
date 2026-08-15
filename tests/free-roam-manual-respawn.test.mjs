import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";

function killForRespawn(room, playerIndex = 0) {
  const player = room.world.players[playerIndex];
  player.combat.health = 0;
  player.combat.alive = false;
  player.combat.respawnRemaining = 8;
  player.combat.knockedDown = true;
  player.combat.knockdownRemaining = 8;
  player.mode = "dead";
  player.activeBoat = null;
  return player;
}

test("manual respawn action survives a press and release before the next server tick", () => {
  const room = createServerFreeRoom(1_000);
  setServerFreePresence(room, "captain", true);
  const player = killForRespawn(room, 0);

  assert.equal(applyServerFreeInput(room, "captain", {action: true}, 1), true);
  assert.equal(applyServerFreeInput(room, "captain", {action: false}, 2), true);

  const snapshot = tickServerFreeRoom(room, 1_040);

  assert.equal(player.combat.alive, true);
  assert.equal(player.combat.health, 100);
  assert.equal(player.combat.respawnRemaining, 0);
  assert.equal(player.mode, "foot");
  assert.equal(player.activeBoat, null);
  assert.equal(player.x, 202);
  assert.equal(player.y, 58);
  assert.ok(snapshot.events.some(event => event.type === "player-respawn"));
});

test("explicit respawn pulse also uses the existing authoritative respawn path", () => {
  const room = createServerFreeRoom(2_000);
  setServerFreePresence(room, "crew", true);
  const player = killForRespawn(room, 1);

  applyServerFreeInput(room, "crew", {respawn: true}, 1);
  applyServerFreeInput(room, "crew", {respawn: false}, 2);
  const snapshot = tickServerFreeRoom(room, 2_040);

  assert.equal(player.combat.alive, true);
  assert.equal(player.mode, "foot");
  assert.equal(player.x, 218);
  assert.equal(player.y, 58);
  assert.ok(snapshot.events.some(event => event.type === "player-respawn"));
});

test("client exposes a dedicated respawn button and the R shortcut", () => {
  const client = fs.readFileSync(new URL("../public/src/free-roam-manual-respawn-client.js", import.meta.url), "utf8");
  const gestures = fs.readFileSync(new URL("../public/src/free-roam-action-gestures.js", import.meta.url), "utf8");

  assert.match(client, /RESPAWN_LABEL = "Возродиться"/);
  assert.match(client, /event\.code !== "KeyR"/);
  assert.match(client, /aria-keyshortcuts/);
  assert.match(client, /setControl\("action", true\)/);
  assert.match(gestures, /free-roam-manual-respawn-client\.js\?v=1/);
});
