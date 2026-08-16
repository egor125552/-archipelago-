import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SpatialSpawnError,
  normalizeSpawnDestination,
  requireSafeSpawn,
  selectSafeSpawn,
} from "../public/src/spatial/spatial-spawn-contract.js";
import {
  applyFreeRoamDockRespawn,
  freeRoamDockRespawnCandidates,
  resolveFreeRoamDockRespawn,
} from "../public/src/free-roam-player-spawn.js";

test("spawn destinations normalize stable identity and true 3D position", () => {
  const spawn = normalizeSpawnDestination({
    id: "spawn.test.entry",
    label: "Вход",
    position: {x: 3, y: 4, z: 5},
    heading: 90,
    mode: "foot",
  });
  assert.equal(spawn.id, "spawn.test.entry");
  assert.deepEqual(spawn.position, {x: 3, y: 4, z: 5});
  assert.equal(spawn.heading, 90);
});

test("safe spawn selection skips an unsafe primary candidate and uses a fallback", () => {
  const selected = selectSafeSpawn([
    {id: "spawn.bad", position: {x: 100, y: 0, z: 0}},
    {id: "spawn.fallback", position: {x: 4, y: 2, z: 0}},
  ], {isSafe: spawn => spawn.position.x < 10});
  assert.equal(selected.id, "spawn.fallback");
});

test("spawn fails explicitly when every declared destination is unsafe", () => {
  assert.throws(() => requireSafeSpawn([
    {id: "spawn.bad", position: {x: 100, y: 0, z: 0}},
  ], {isSafe: () => false}), SpatialSpawnError);
});

test("free-roam dock respawn keeps the exact legacy player positions", () => {
  const first = resolveFreeRoamDockRespawn(0);
  const second = resolveFreeRoamDockRespawn(1);
  assert.deepEqual(first.position, {x: 202, y: 58, z: 0});
  assert.deepEqual(second.position, {x: 218, y: 58, z: 0});
  assert.equal(first.heading, 180);
  assert.equal(second.heading, 180);
  assert.equal(first.mode, "foot");
  assert.equal(freeRoamDockRespawnCandidates(0).length, 1);
});

test("free-roam adapter applies only legacy placement fields, not combat state", () => {
  const player = {
    mode: "dead",
    activeBoat: 1,
    x: 10,
    y: 20,
    heading: 30,
    combat: {health: 0, alive: false, respawnRemaining: 0},
  };
  applyFreeRoamDockRespawn(player, resolveFreeRoamDockRespawn(0));
  assert.equal(player.mode, "foot");
  assert.equal(player.activeBoat, null);
  assert.equal(player.x, 202);
  assert.equal(player.y, 58);
  assert.equal(player.heading, 180);
  assert.deepEqual(player.combat, {health: 0, alive: false, respawnRemaining: 0});
  assert.equal(Object.hasOwn(player, "z"), false, "legacy free-roam must not gain a new runtime field during this migration");
});

test("legacy combat delegates dock placement instead of owning respawn coordinates", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat.js", import.meta.url), "utf8");
  assert.match(source, /resolveFreeRoamDockRespawn\(playerIndex\)/);
  assert.match(source, /applyFreeRoamDockRespawn\(player, spawn\)/);
  assert.doesNotMatch(source, /player\.x\s*=\s*210\s*\+/);
  assert.doesNotMatch(source, /player\.y\s*=\s*58/);
  assert.match(source, /combat\.health\s*=\s*100/);
  assert.match(source, /combat\.alive\s*=\s*true/);
});
