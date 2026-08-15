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

test("manual respawn pulse waits until threat intelligence observed the death", () => {
  const room = createServerFreeRoom(1_000);
  setServerFreePresence(room, "captain", true);
  tickServerFreeRoom(room, 1_040);
  const player = killForRespawn(room, 0);

  applyServerFreeInput(room, "captain", {respawn: true}, 1);
  applyServerFreeInput(room, "captain", {respawn: false}, 2);
  const deathTick = tickServerFreeRoom(room, 1_080);

  assert.equal(player.combat.alive, false);
  assert.equal(player.combat.respawnRemaining, 0);
  assert.ok(deathTick.events.some(event => event.type === "threat-player-down"));
  assert.equal(deathTick.events.some(event => event.type === "player-respawn"), false);

  const returnTick = tickServerFreeRoom(room, 1_120);
  assert.equal(player.combat.alive, true);
  assert.equal(player.combat.health, 100);
  assert.equal(player.mode, "foot");
  assert.ok(returnTick.events.some(event => event.type === "player-respawn"));
  assert.ok(returnTick.events.some(event => event.type === "threat-player-returned"));
  assert.ok(room.world.freeThreatIntelligence.graceUntil[0] > room.world.time);
});

test("respawn pulse does nothing while the player is alive", () => {
  const room = createServerFreeRoom(2_000);
  setServerFreePresence(room, "captain", true);
  const player = room.world.players[0];
  tickServerFreeRoom(room, 2_040);

  applyServerFreeInput(room, "captain", {respawn: true}, 1);
  applyServerFreeInput(room, "captain", {respawn: false}, 2);
  const snapshot = tickServerFreeRoom(room, 2_080);

  assert.equal(player.combat.alive, true);
  assert.equal(snapshot.events.some(event => event.type === "player-respawn"), false);
});

test("client uses a dedicated R respawn pulse instead of the generic action control", () => {
  const client = fs.readFileSync(new URL("../public/src/free-roam-manual-respawn-client.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/free-roam-server.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/free-roam.html", import.meta.url), "utf8");

  assert.match(client, /event\.code !== "KeyR"/);
  assert.match(client, /setControl\("respawn", true\)/);
  assert.doesNotMatch(client, /actionButton\.click\(\)/);
  assert.match(server, /"megaBomb", "respawn"/);
  assert.match(server, /observed\[index\] !== false/);
  assert.match(html, /id="respawnButton"[^>]*aria-keyshortcuts="R"[^>]*>Возродиться<\/button>/);
  assert.match(html, /free-roam-manual-respawn-client\.js\?v=1/);
});
